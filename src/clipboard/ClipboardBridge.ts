import { execFile } from "child_process";
import * as vscode from "vscode";
import { looksLikeReply, normalizeClipboard } from "../protocol/replyDetect";
import { cfg, workspaceRoot, writeText } from "../util";
import { ClipboardOwner } from "./ClipboardOwner";

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

  /**
   * Uloží prompt do schránky. Nad prahem `clipboard.fileAboveChars` (jen Windows)
   * ho zapíše jako .txt a do schránky dá soubor, který se v chatu vloží jako příloha.
   * Vrací "text" nebo "file".
   */
  async copyPrompt(text: string, turn?: number, attachments: string[] = []): Promise<"text" | "file"> {
    this.lastPrompt = text;
    const threshold = cfg<number>("clipboard.fileAboveChars", 0);
    const wantFile = attachments.length > 0 || (threshold > 0 && text.length > threshold);
    if (wantFile && process.platform === "win32") {
      try {
        const uri = vscode.Uri.joinPath(workspaceRoot(), ".whisper", `prompt-${turn ?? "x"}.txt`);
        await writeText(uri, text);
        const files = [uri.fsPath, ...attachments.map((a) => vscode.Uri.joinPath(workspaceRoot(), a).fsPath)];
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
    });
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
  }
}
