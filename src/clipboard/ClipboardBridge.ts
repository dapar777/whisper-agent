import { execFile } from "child_process";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { DragHelper } from "./DragDrop";
import { isOwnPrompt, looksLikeReply, normalizeClipboard } from "../protocol/replyDetect";
import { classifyProse } from "../protocol/PromptBuilder";
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

  /** prompt byl skutečně vložen (jiná aplikace si vyžádala obsah) – od té chvíle může přijít i odpověď bez bloku */
  private pastedSincePrompt = false;

  constructor() {
    this.owner.onDidPaste(() => {
      this.pastedSincePrompt = true;
    });
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
  /** svazky, které se v tomto kole podařilo vložit do historie schránky (Win+V) */
  lastHistoryItems: string[] = [];
  /** složka se skripty extensionu (dragdrop.py); nastaví extension.ts */
  scriptsDir = "";
  /** trvale běžící pomocník pro tažení (spouští se líně nebo předem, když prompt má přílohu) */
  private helper: DragHelper | undefined;

  private dragHelper(): DragHelper {
    if (!this.helper) {
      this.helper = new DragHelper(this.scriptsDir, () => cfg<string>("bundle.python", "python"), (l) => this.logEmitter.fire(l));
    }
    return this.helper;
  }

  /** Spustí pomocníka pro tažení na pozadí, aby první tažení začalo hned (start Pythonu trvá přes sekundu). */
  warmUpDrag(): void {
    if (process.platform === "win32") this.dragHelper().warmUp();
  }

  /** Zruší tažení, které právě běží. */
  cancelDrag(): void {
    this.helper?.cancel();
  }

  get dragging(): boolean {
    return !!this.helper?.busy;
  }
  /** hlášky pro log v panelu (sledování složky s odpověďmi) */
  readonly onDidLog = this.logEmitter.event;
  private readonly noticeEmitter = new vscode.EventEmitter<{ text: string; icon?: string }>();
  /** oznámení pro uživatele přímo do proudu v panelu (tažení přílohy, selhání doručení) */
  readonly onDidNotify = this.noticeEmitter.event;

  private notify(text: string, icon?: string): void {
    this.logEmitter.fire(text);
    this.noticeEmitter.fire({ text, icon });
  }

  /**
   * Uloží prompt do schránky. Nad prahem `clipboard.fileAboveChars` (jen Windows)
   * ho zapíše jako .txt a do schránky dá soubor, který se v chatu vloží jako příloha.
   * Vrací "text" nebo "file".
   */
  async copyPrompt(text: string, turn?: number, attachments: string[] = []): Promise<"text" | "file"> {
    text = decoratePrompt(text, turn);
    this.lastPrompt = text;
    this.pastedSincePrompt = false;
    const threshold = cfg<number>("clipboard.fileAboveChars", 0);
    // textové přílohy (svazky souborů z <bundle>): do historie schránky (Win+V) jako samostatné texty
    // PŘED promptem, takže Ctrl+V vloží prompt a z historie se vezme svazek; obrázky jdou jako soubory
    const textual = attachments.filter((a) => /\.(txt|md)$/i.test(a));
    const binary = attachments.filter((a) => !/\.(txt|md)$/i.test(a));
    const delivery = cfg<"history" | "file" | "drag">("bundle.delivery", "history");
    // prompt s přílohou: uživatel ji nejspíš potáhne, ať pomocník už běží a tažení začne hned
    if (attachments.length) this.warmUpDrag();
    if (delivery === "drag" && attachments.length && process.platform === "win32") {
      // prompt jde jako text; přílohy (svazky i obrázky) se táhnou do chatu z klávesnice (dragdrop.py)
      this.lastHistoryItems = [];
      if (!(await this.owner.take(text))) await vscode.env.clipboard.writeText(text);
      void this.dragFiles(attachments.map((a) => vscode.Uri.joinPath(workspaceRoot(), a).fsPath));
      return "text";
    }
    if (delivery === "history" && textual.length && binary.length === 0 && !(threshold > 0 && text.length > threshold)) {
      const copied: string[] = [];
      for (const a of textual) {
        try {
          // svazek čteme přímo ze souboru (readText preferuje otevřený editor, což je tu zbytečné)
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(workspaceRoot(), a));
          const content = Buffer.from(bytes).toString("utf8");
          await vscode.env.clipboard.writeText(content);
          // historie schránky si položku uloží až po chvíli; bez pauzy by ji prompt přepsal dřív
          await new Promise((r) => setTimeout(r, 400));
          copied.push(a);
        } catch (e) {
          // tichý pád by uživateli vzal přílohu bez varování: nahlásíme a necháme ji jako soubor
          this.notify(`Svazek ${a} se nepodařilo dát do historie schránky (${(e as Error).message}); zkusím ho přiložit jako soubor.`, "alert");
        }
      }
      // do historie šlo jen to, co se povedlo; zbytek pokračuje cestou souborů
      attachments = attachments.filter((a) => !copied.includes(a));
      this.lastHistoryItems = copied;
    } else {
      this.lastHistoryItems = [];
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

  /**
   * Přetáhne soubory do chatu z klávesnice (scripts/dragdrop.py): uživatel Alt+Tabem přepne do chatu,
   * Enter pustí, Esc zruší. Výsledek a případné selhání (chybí Python/pywin32) hlásí do logu panelu.
   */
  async dragFiles(files: string[], mouse = false): Promise<void> {
    if (!files.length) return;
    const helper = this.dragHelper();
    if (helper.busy) {
      // druhé kliknutí během tažení = zrušit; jinak by se na sebe požadavky vršily
      helper.cancel();
      this.logEmitter.fire("Tažení už běželo, ruším ho.");
      return;
    }
    const names = files.map((f) => path.basename(f)).join(", ");
    if (mouse) {
      // myší tažení: uživatel drží tlačítko, hlášku dáváme jen do stavového řádku, ať nepřekáží
      vscode.window.setStatusBarMessage(`$(move) Whisper: táhněte ${names} do okna chatu a pusťte tlačítko`, 30000);
    } else {
      this.notify(`Táhnu ${names}: Alt+Tab do chatu (kurzor skočí do okna), Enter pustí, Esc zruší. Pak Ctrl+V vloží prompt.`, "move");
      vscode.window.setStatusBarMessage(`$(move) Whisper: táhnu ${names}: Alt+Tab do chatu, Enter pustí`, 30000);
    }
    const t0 = Date.now();
    const r = await helper.drag(files, mouse ? "mouse" : "keyboard");
    this.logEmitter.fire(`Tažení (${mouse ? "myš" : "klávesnice"}) skončilo: ${r.result}${r.detail ? ` (${r.detail})` : ""}, ${Date.now() - t0} ms celkem${r.ms !== undefined ? `, ${r.ms} ms v pomocníkovi` : ""}.`);
    if (r.result === "copy" || r.result === "move") this.notify(`${names}: puštěno do okna.`, "check");
    else if (r.result === "none") {
      if (!mouse) this.notify(`Tažení ${names} zrušeno (Esc). Znovu tlačítkem „Táhnout přílohu do chatu“, nebo soubor přiložte ručně z .whisper/out/.`, "undo");
      else vscode.window.setStatusBarMessage("Whisper: tažení nezačalo (tlačítko už nebylo držené) nebo bylo zrušeno", 4000);
    } else if (r.detail === "busy") {
      this.logEmitter.fire("Tažení už běží.");
    } else if (/locked|foreground/.test(r.detail)) {
      this.notify(`Tažení teď nejde: ${r.detail}. Odemkněte počítač a zkuste to znovu.`, "alert");
    } else
      this.notify(
        `Tažení se nepovedlo (${r.detail === "ENOENT" ? "python nenalezen; nastavte whisper.bundle.python" : r.detail}). ` +
          `Vyžaduje Python s pywin32 (pip install pywin32). Přílohu přiložte ručně: ${names}.`,
        "alert",
      );
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
      if (looksLikeReply(text, this.lastPrompt) || this.looksLikeProseReply(text)) this.waiter.resolve(text);
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

  /**
   * Složka, ve které se čeká na odpověď jako soubor: `whisper.reply.watchDir`, jinak v režimu souboru
   * složka stahování uživatele; prázdný řetězec = soubory se nesledují.
   */
  replyDir(): string {
    const dir = cfg<string>("reply.watchDir", "").trim();
    if (dir) return dir;
    if (cfg<string>("reply.mode", "file") !== "file") return "";
    return path.join(os.homedir(), "Downloads");
  }

  /** Odpověď může přijít i jako nový soubor ve složce `whisper.reply.watchDir` (např. stažený z chatu). */
  private startFileWatch(): void {
    this.fileWatcher?.stop();
    this.fileWatcher = undefined;
    const dir = this.replyDir();
    if (!dir) return;
    this.fileWatcher = new FileReplyWatcher({
      dir,
      pattern: cfg<string>("reply.filePattern", "*.{xml,md,txt}"),
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
      else if (this.looksLikeProseReply(text)) this.waiter.resolve(text);
      else if (seen !== normalizeClipboard(this.lastPrompt)) this.otherEmitter.fire(); // uživatel zkopíroval něco jiného → prompt už odnesl
    }, poll);
  }

  /**
   * Odpověď modelu BEZ bloku (dokument napsaný do chatu, rozepsaný <whisper>): po vložení promptu ji
   * převezmeme také, jinak by agent čekal donekonečna a uživatel by neviděl, že se nic nestalo.
   * Bez vlastníka schránky (jiné platformy) se vložení poznat nedá, tam stačí, že to není náš prompt.
   */
  private looksLikeProseReply(text: string): boolean {
    if (!this.pastedSincePrompt && process.platform === "win32") return false;
    const t = normalizeClipboard(text);
    if (t.length < 300 || isOwnPrompt(t) || t === normalizeClipboard(this.lastPrompt)) return false;
    return t.includes("<whisper") || classifyProse(t) === "document";
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
    this.helper?.dispose(); // cancel + EOF: pomocník uklidí stisk i hook a skončí
    this.owner.dispose();
    this.otherEmitter.dispose();
    this.logEmitter.dispose();
  }
}
