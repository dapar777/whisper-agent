import { execFile } from "child_process";
import * as vscode from "vscode";
import { looksLikeReply, normalizeClipboard } from "../protocol/replyDetect";
import { cfg, readText, workspaceName, workspaceRoot, writeText } from "../util";
import { ClipboardOwner } from "./ClipboardOwner";
import { FileReplyWatcher } from "./FileReplyWatcher";

/** Windows: vloží do schránky soubory (file drop list); prohlížeč je po Ctrl+V připojí jako přílohy. */
function setClipboardFiles(fsPaths: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const list = fsPaths.map((p) => `'${p.replace(/'/g, "''")}'`).join(",");
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `Set-Clipboard -Path @(${list})`],
      { windowsHide: true, timeout: 10000 },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

/**
 * Uživatelská hlavička a patička promptu (whisper.prompt.header / footer), např. „Odpověz česky“
 * nebo pokyn pro konkrétní chat. Zástupné znaky: {turn}, {project}. Prázdné = nic.
 */
export function decoratePrompt(text: string, turn?: number): string {
  const fill = (s: string) => s.replace(/\{turn\}/g, String(turn ?? "")).replace(/\{project\}/g, workspaceName()).trim();
  const header = fill(cfg<string>("prompt.header", ""));
  const footer = fill(cfg<string>("prompt.footer", ""));
  return (header ? header + "\n\n" : "") + text + (footer ? "\n\n" + footer : "");
}

/**
 * Přenos promptů a odpovědí přes schránku. Při čekání na odpověď polluje
 * schránku a odpověď převezme, jakmile se v ní objeví blok <whisper>.
 */
export class ClipboardBridge implements vscode.Disposable {
  private lastPrompt = "";
  private readonly otherEmitter = new vscode.EventEmitter<void>();
  /** Ve schránce se objevilo něco jiného než náš prompt a než odpověď (uživatel pracuje v chatu). */
  readonly onDidCopyOther = this.otherEmitter.event;
  /** Vlastník schránky s odloženým vykreslením: hlásí skutečné vložení promptu (Windows). */
  private readonly owner = new ClipboardOwner();
  readonly onDidPaste = this.owner.onDidPaste;

  constructor() {
    // uživatel zkopíroval něco jiného (typicky odpověď): schránku hned přečteme
    this.owner.onDidLose(() => {
      this.otherEmitter.fire();
      void this.pollOnce();
    });
  }
  private timer: NodeJS.Timeout | undefined;
  private waiter: { resolve: (text: string) => void; reject: (e: Error) => void } | undefined;
  private fileWatcher: FileReplyWatcher | undefined;
  private readonly logEmitter = new vscode.EventEmitter<string>();
  /** hlášky pro log v panelu (sledování složky s odpověďmi) */
  readonly onDidLog = this.logEmitter.event;

  /**
   * Uloží prompt do schránky. Nad prahem `clipboard.fileAboveChars` (jen Windows)
   * ho zapíše jako .txt a do schránky dá soubor, který se v chatu vloží jako příloha.
   * Vrací "text" nebo "file".
   */
  async copyPrompt(text: string, turn?: number, attachments: string[] = []): Promise<"text" | "file"> {
    text = decoratePrompt(text, turn);
    this.lastPrompt = text;
    const threshold = cfg<number>("clipboard.fileAboveChars", 0);
    // textové přílohy (svazky souborů z <bundle>): do historie schránky (Win+V) jako samostatné texty
    // PŘED promptem, takže Ctrl+V vloží prompt a z historie se vezme svazek; obrázky jdou jako soubory
    const textual = attachments.filter((a) => /\.(txt|md)$/i.test(a));
    const binary = attachments.filter((a) => !/\.(txt|md)$/i.test(a));
    const delivery = cfg<"history" | "file">("bundle.delivery", "history");
    if (delivery === "history" && textual.length && binary.length === 0 && !(threshold > 0 && text.length > threshold)) {
      for (const a of textual) {
        try {
          const content = await readText(vscode.Uri.joinPath(workspaceRoot(), a));
          await vscode.env.clipboard.writeText(content);
          // historie schránky si položku uloží až po chvíli; bez pauzy by ji prompt přepsal dřív
          await new Promise((r) => setTimeout(r, 400));
        } catch {
          /* svazek zůstává na disku; prompt na něj odkazuje */
        }
      }
      attachments = [];
    }
    const wantFile = attachments.length > 0 || (threshold > 0 && text.length > threshold);
    if (wantFile && process.platform === "win32") {
      try {
        const uri = vscode.Uri.joinPath(workspaceRoot(), ".whisper", `prompt-${turn ?? "x"}.txt`);
        await writeText(uri, text);
        // chaty berou jako přílohu jen některé formáty: textové přílohy jdou vždy jako *.txt
        const files = [uri.fsPath, ...(await Promise.all(attachments.map((a) => this.asTxt(a))))];
        await setClipboardFiles(files);
        return "file";
      } catch {
        /* spadne zpět na text */
      }
    }
    const finalText = attachments.length
      ? text + `\n\n[Attachments could not be put on the clipboard as files; please attach manually: ${attachments.join(", ")}]`
      : text;
    // Windows: převzít schránku s odloženým vykreslením, aby šlo poznat skutečné vložení
    if (await this.owner.take(finalText)) return "text";
    await vscode.env.clipboard.writeText(finalText);
    return "text";
  }

  /** Absolutní cesta přílohy; textový soubor bez přípony .txt se zkopíruje do .txt (chat jiné formáty nebere). */
  private async asTxt(rel: string): Promise<string> {
    const uri = vscode.Uri.joinPath(workspaceRoot(), rel);
    if (/\.(png|jpe?g|gif|webp|txt)$/i.test(rel)) return uri.fsPath;
    try {
      const copy = vscode.Uri.file(uri.fsPath.replace(/\.[^.\\/]+$/, "") + ".txt");
      await vscode.workspace.fs.copy(uri, copy, { overwrite: true });
      return copy.fsPath;
    } catch {
      return uri.fsPath;
    }
  }

  /** Jednorázové přečtení schránky (po ztrátě vlastnictví); odpověď se převezme hned. */
  private async pollOnce(): Promise<void> {
    if (!this.waiter) return;
    try {
      const text = await vscode.env.clipboard.readText();
      if (looksLikeReply(text, this.lastPrompt)) this.waiter.resolve(text);
    } catch {
      /* ignore */
    }
  }

  get currentPrompt(): string {
    return this.lastPrompt;
  }

  /** Odpověď modelu = blok s číselným kolem, ne náš vlastní prompt (bez ohledu na CRLF/LF). */
  static looksLikeReply(text: string, lastPrompt = ""): boolean {
    return looksLikeReply(text, lastPrompt);
  }

  /** Čeká na odpověď ve schránce (nebo ruční vložení přes submitManual). */
  waitForReply(token: vscode.CancellationToken): Promise<string> {
    this.cancelWait(new Error("superseded"));
    return new Promise<string>((resolve, reject) => {
      this.waiter = { resolve, reject };
      const sub = token.onCancellationRequested(() => this.cancelWait(new Error("cancelled")));
      const finish = (text: string) => {
        sub.dispose();
        this.stopPolling();
        this.waiter = undefined;
        resolve(text);
      };
      this.waiter = {
        resolve: finish,
        reject: (e) => {
          sub.dispose();
          this.stopPolling();
          this.waiter = undefined;
          reject(e);
        },
      };
      if (cfg<boolean>("clipboard.watch", true)) this.startPolling();
      this.startFileWatch();
    });
  }

  /** Odpověď může přijít i jako nový soubor ve složce `whisper.reply.watchDir` (např. stažený z chatu). */
  private startFileWatch(): void {
    this.fileWatcher?.stop();
    this.fileWatcher = undefined;
    const dir = cfg<string>("reply.watchDir", "").trim();
    if (!dir) return;
    this.fileWatcher = new FileReplyWatcher({
      dir,
      pattern: cfg<string>("reply.filePattern", "*.{md,txt}"),
      pollMs: Math.max(500, cfg<number>("clipboard.pollMs", 500)),
      lastPrompt: this.lastPrompt,
      log: (l) => this.logEmitter.fire(l),
      onReply: (text) => this.waiter?.resolve(text),
    });
    this.fileWatcher.start();
  }

  /** Ruční vložení odpovědi (příkaz nebo textarea v sidebaru). */
  submitManual(text: string): boolean {
    if (!this.waiter) return false;
    this.waiter.resolve(text);
    return true;
  }

  private startPolling(): void {
    this.stopPolling();
    const poll = Math.max(200, cfg<number>("clipboard.pollMs", 500));
    let lastSeen = normalizeClipboard(this.lastPrompt);
    this.timer = setInterval(async () => {
      if (!this.waiter) return this.stopPolling();
      // dokud schránku vlastníme my, obsah známe; čtení by navíc spustilo naše vlastní vykreslení
      if (this.owner.alive) return;
      let text: string;
      try {
        text = await vscode.env.clipboard.readText();
      } catch {
        return;
      }
      // Windows vrací CRLF i pro text zapsaný s LF, proto porovnáváme normalizovaně
      const seen = normalizeClipboard(text);
      if (seen === lastSeen) return;
      lastSeen = seen;
      if (looksLikeReply(text, this.lastPrompt)) this.waiter.resolve(text);
      else if (seen !== normalizeClipboard(this.lastPrompt)) this.otherEmitter.fire(); // uživatel zkopíroval něco jiného → prompt už odnesl
    }, poll);
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.fileWatcher?.stop();
    this.fileWatcher = undefined;
  }

  private cancelWait(err: Error): void {
    const w = this.waiter;
    this.waiter = undefined;
    this.stopPolling();
    w?.reject(err);
  }

  dispose(): void {
    this.cancelWait(new Error("disposed"));
    this.owner.dispose();
    this.otherEmitter.dispose();
    this.logEmitter.dispose();
  }
}
