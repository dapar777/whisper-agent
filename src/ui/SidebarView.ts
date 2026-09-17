import * as vscode from "vscode";
import { Controller } from "../agent/Controller";

/**
 * Chatové UI ve stylu Claude Code: průběh nahoře, vstup dole, inline schvalování,
 * výrazný stav, lomítkové příkazy s doplňováním, plán a návrhy jako karty.
 */
export class SidebarView implements vscode.WebviewViewProvider {
  static readonly viewId = "whisper.sidebar";
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly controller: Controller,
    private readonly extensionUri: vscode.Uri,
  ) {
    controller.onDidChange(() => void this.push());
    controller.session.onDidChange(() => void this.push());
    controller.review.onDidChange(() => void this.push());
  }

  /** Odznak na ikoně panelu (počet věcí, které čekají na uživatele). */
  setBadge(value: number, tooltip: string): void {
    if (!this.view) return;
    this.view.badge = value > 0 ? { value, tooltip } : undefined;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: { type: string; reqId?: number }) => {
      // každý požadavek z panelu se potvrdí (ack): panel do té doby ukazuje „⏳ dělám…“ a tlačítko je zamčené
      const ack = (error?: string) => {
        if (m.reqId) void view.webview.postMessage({ type: "ack", reqId: m.reqId, error });
      };
      this.onMessage(m).then(
        () => ack(),
        (e: Error) => {
          ack(e.message);
          void vscode.window.showErrorMessage(`Whisper: ${e.message}`);
        },
      );
    });
    view.onDidChangeVisibility(() => void this.push());
    // změna nastavení (v panelu i v nastavení VS Code) se má v horní liště projevit hned
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("whisper")) void this.push();
    });
    void this.push();
  }

  private async onMessage(m: { type: string; text?: string; path?: string; id?: string; allow?: boolean; always?: string; approve?: boolean; mode?: "ask" | "auto" }): Promise<void> {
    const c = this.controller;
    switch (m.type) {
      case "ready":
        return this.push();
      case "send":
        return c.submit(m.text ?? "");
      case "approve":
        return c.approvals.decide(m.id!, !!m.allow, m.always);
      case "suggestion":
        return c.decideSuggestion(m.id!, !!m.approve);
      case "suggestionsAll":
        return c.decideAllSuggestions(!!m.approve);
      case "setMode":
        return c.approvals.setMode(m.mode ?? "ask");
      case "autoAll":
        return c.approvals.switchToAuto();
      case "addPattern": // approve = globálně
        return c.approvals.addAllowPattern(m.text ?? "", !!m.approve);
      case "removePattern":
        return c.approvals.removeAllowPattern(m.text ?? "", m.approve ? "global" : "workspace");
      case "copyAgain":
        return c.copyPromptAgain();
      case "drag":
        return c.dragAttachments();
      case "dragMouse":
        // uživatel chytil pole s přílohou myší; tlačítko drží on, jen mu dodáme soubor
        return c.dragAttachments(m.path, true);
      case "setDelivery": {
        // přepínač v horní liště: drag = svazky a přílohy se hned táhnou do chatu; jinak historie schránky
        const value = m.text === "drag" || m.text === "file" ? m.text : "history";
        await vscode.workspace.getConfiguration("whisper").update("bundle.delivery", value, vscode.ConfigurationTarget.Global);
        vscode.window.setStatusBarMessage(value === "drag" ? "$(move) Whisper: bundle se bude automaticky táhnout do chatu" : "Whisper: bundle půjde do historie schránky", 4000);
        return this.push();
      }
      case "showPrompt":
        return c.showPrompt();
      case "pasteClip":
        return void vscode.commands.executeCommand("whisper.pasteReply");
      case "stop":
        return c.abort();
      case "interrupt":
        return c.interrupt();
      case "correction":
        return c.sendCorrection();
      case "undo":
        return c.undoTurn();
      case "resend":
        return c.resendContext();
      case "suggest":
        return c.runSuggest();
      case "reloadSkills":
        return c.reloadSkills();
      case "transcript":
        return c.showTranscript();
      case "settings":
        return void vscode.commands.executeCommand("whisper.openSettings");
      case "reviewNext":
        return void vscode.commands.executeCommand("whisper.review.next");
      case "acceptAll":
        return c.review.acceptAll();
      case "rejectAll":
        return c.review.rejectAll();
      case "acceptFile":
        return c.review.accept(m.path!);
      case "rejectFile":
        return c.review.reject(m.path!);
      case "openDiff":
        return c.review.openDiff(m.path!);
      case "openFile":
        return c.openFileAt(m.path ?? "", Number(m.text) || undefined, Number(m.always) || undefined);
    }
  }

  private pushTimer: NodeJS.Timeout | undefined;
  private pushing = false;
  private pushAgain = false;
  /** seznam souborů workspace pro doplňování #odkazů: drahý (findFiles), proto cache a posílá se jen při změně */
  private filesCache: { at: number; list: string[]; version: number } = { at: 0, list: [], version: 0 };
  private filesRefreshing = false;
  private filesSentVersion = -1;

  /**
   * Překreslení panelu: změny se sbírají (několik událostí za sebou = jedno překreslení) a nikdy neběží
   * dvě najednou; když během sběru dat přijde další změna, překreslí se hned potom ještě jednou.
   */
  push(): Promise<void> {
    if (this.pushTimer) return Promise.resolve();
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      void this.pushNow();
    }, 30);
    return Promise.resolve();
  }

  private async pushNow(): Promise<void> {
    if (this.pushing) {
      this.pushAgain = true;
      return;
    }
    this.pushing = true;
    try {
      await this.doPush();
    } finally {
      this.pushing = false;
      if (this.pushAgain) {
        this.pushAgain = false;
        void this.push();
      }
    }
  }

  /** Soubory workspace z cache (obnova na pozadí nejvýš jednou za 15 s); první volání počká. */
  private async workspaceFilesCached(): Promise<{ list: string[]; version: number }> {
    const stale = Date.now() - this.filesCache.at > 15_000;
    if (stale && !this.filesRefreshing) {
      this.filesRefreshing = true;
      const refresh = this.controller
        .workspaceFiles()
        .then((list) => {
          const changed = list.length !== this.filesCache.list.length || list.some((f, i) => f !== this.filesCache.list[i]);
          this.filesCache = { at: Date.now(), list, version: changed ? this.filesCache.version + 1 : this.filesCache.version };
          if (changed && this.filesCache.at) void this.push();
        })
        .catch(() => undefined)
        .finally(() => (this.filesRefreshing = false));
      if (this.filesCache.at === 0) await refresh; // poprvé: bez seznamu by doplňování nefungovalo
    }
    return this.filesCache;
  }

  private async doPush(): Promise<void> {
    if (!this.view) return;
    const c = this.controller;
    const hunks = c.review.pendingFiles.length ? await c.review.pendingHunks() : [];
    const files = await this.workspaceFilesCached();
    const s = c.session.current;
    const state = {
      session: s
        ? {
            state: s.state,
            turn: s.turn,
            task: s.task,
            planMode: !!s.planMode,
            pendingQuestion: s.pendingQuestion,
            pendingOptions: s.pendingOptions,
            pendingMulti: s.pendingMulti,
            finalSummary: s.finalSummary,
            plan: s.plan,
            promptChars: s.pendingPrompt.length,
            suggestions: s.suggestions ?? [],
            attachments: c.attachmentInfo(),
            historyItems: c.clipboard.lastHistoryItems,
            delivery: vscode.workspace.getConfiguration("whisper").get<string>("bundle.delivery", "history"),
            reply: { mode: vscode.workspace.getConfiguration("whisper").get<string>("reply.mode", "file"), dir: c.clipboard.replyDir() },
          }
        : undefined,
      items: c.items.slice(-150),
      current: c.currentAction,
      promptPhase: c.promptPhase,
      delivery: vscode.workspace.getConfiguration("whisper").get<string>("bundle.delivery", "history"),
      approvals: { mode: c.approvals.mode, pending: c.approvals.pendingRequests, history: c.approvals.history.slice(-8), patterns: c.approvals.allowPatterns() },
      review: c.review.pendingFiles.map((f) => ({ path: f.path, kind: f.kind, hunks: hunks.filter((h) => h.path === f.path).length })),
      commands: c.commands().map((x) => ({ name: x.name, kind: x.kind, description: x.description })),
      // seznam souborů jen když se změnil (panel si drží minulý); ušetří serializaci tisíců řetězců při každém překreslení
      files: files.version !== this.filesSentVersion ? files.list : undefined,
      editor: c.editorInfo(),
      log: c.log.slice(-80),
    };
    const posted = await this.view.webview.postMessage({ type: "state", state });
    if (posted && state.files) this.filesSentVersion = files.version;
  }

  private html(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2);
    return /* html */ `<!DOCTYPE html>
<html lang="cs"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
<style>
  :root {
    --bg: var(--vscode-sideBar-background);
    --fg: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground);
    --card: var(--vscode-editorWidget-background);
    --border: var(--vscode-widget-border, rgba(128,128,128,.25));
    --accent: #d97757;
    --accent-fg: #ffffff;
    --ok: var(--vscode-charts-green, #3fb950);
    --warn: var(--vscode-charts-yellow, #d29922);
    --err: var(--vscode-errorForeground, #f85149);
    --info: var(--vscode-charts-blue, #58a6ff);
    --mono: var(--vscode-editor-font-family, Consolas, monospace);
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { height: 100%; margin: 0; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--fg); background: var(--bg); display: flex; flex-direction: column; }
  button { font: inherit; border: 1px solid var(--border); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); padding: 4px 10px; border-radius: 6px; cursor: pointer; }
  button:hover { filter: brightness(1.1); }
  button.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
  button.ghost { background: transparent; border-color: transparent; color: var(--muted); padding: 2px 6px; }
  button.ghost:hover { color: var(--fg); background: var(--card); }
  button.small { padding: 2px 8px; font-size: 11px; border-radius: 5px; }
  input[type=text], textarea { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 6px; padding: 6px 8px; width: 100%; }
  textarea:focus, input:focus { outline: 1px solid var(--vscode-focusBorder); }
  pre, code { font-family: var(--mono); font-size: 11.5px; }
  pre { margin: 6px 0 0; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12)); padding: 6px 8px; border-radius: 6px; }

  /* horní lišta */
  .topbar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--border); flex-wrap: wrap; row-gap: 4px; }
  .topbar .pill { flex: 0 0 auto; }
  .topbar .menu { display: flex; gap: 2px; flex: 0 0 auto; margin-left: auto; }
  .topbar .spacer { min-width: 4px; }
  @media (max-width: 380px) { .logo span:last-child { display: none; } }
  .logo { display: flex; align-items: center; gap: 6px; font-weight: 600; letter-spacing: .2px; }
  .logo .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); }
  .spacer { flex: 1; }
  .pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
  .pill.on { border-color: var(--accent); color: var(--accent); }
  .pill.busy { color: var(--accent); border-color: var(--accent); max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
  .pill.busy.ok { color: var(--ok, #3c9); border-color: var(--ok, #3c9); }
  .pill.busy.err { color: var(--error, #e55); border-color: var(--error, #e55); }
  button.busy { opacity: 0.6; cursor: progress; }
  /* ikony: inline SVG, tenká linka, barva podle textu (jako codicons ve VS Code) */
  .ic { width: 14px; height: 14px; vertical-align: -2px; flex: 0 0 auto; }
  .topbar .ghost .ic, .slashbtn .ic, #send .ic { width: 15px; height: 15px; }
  .head .ic { width: 13px; height: 13px; margin-right: 5px; opacity: 0.85; }
  .line .ic, .att .ic, .chip .ic { width: 12px; height: 12px; margin-right: 3px; }
  .ic.spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* stavový banner: plave na konci proudu, ne nad ním */
  .banner { margin: 2px 0 4px; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--border); background: var(--card); display: flex; flex-direction: column; gap: 4px; }
  .banner .title { line-height: 1.35; }
  .banner .title { display: flex; align-items: center; gap: 8px; font-weight: 600; }
  .banner .sub { color: var(--muted); font-size: 12px; }
  .banner .btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; min-width: 0; }
  .banner .btns button { flex: 0 1 auto; max-width: 100%; }
  .banner.waiting { border-color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, var(--card)); }
  .banner.executing { border-color: var(--info); }
  .banner.asking { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--card)); }
  .banner.done { border-color: var(--ok); }
  .beacon { width: 10px; height: 10px; border-radius: 50%; background: var(--warn); animation: pulse 1.2s ease-in-out infinite; }
  .banner.executing .beacon { background: var(--info); animation-duration: .6s; }
  .banner.asking .beacon { background: var(--accent); }
  .banner.done .beacon { background: var(--ok); animation: none; }
  @keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 0%, transparent); opacity: 1 } 50% { opacity: .35 } }

  /* chat: jediná rolovací oblast, vše ostatní je uvnitř ní */
  #chat { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
  #stream { display: flex; flex-direction: column; align-items: stretch; gap: 8px; min-width: 0; }
  #stream > * { max-width: 100%; }
  /* karta uvnitř proudu (změny, návrhy) */
  .card { padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); font-size: 12px; }
  .card .row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 2px 0; min-width: 0; }
  .card .path { flex: 1; font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* skládací panel pod lištou (výjimky schvalování) */
  .sheet { margin: 0 10px 8px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
  .sheet .title { font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .sheet summary { cursor: pointer; }
  .sheet .sub { color: var(--muted); font-size: 11px; }
  .sheet .btns { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .msg { max-width: 100%; min-width: 0; border-radius: 10px; padding: 8px 10px; border: 1px solid var(--border); background: var(--card); font-size: 12.5px; line-height: 1.45; overflow-wrap: anywhere; }
  .msg .head { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); margin-bottom: 4px; }
  .msg .head b { color: var(--fg); }
  .msg.user { align-self: flex-end; background: color-mix(in srgb, var(--accent) 18%, var(--card)); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); max-width: 92%; }
  .msg.model { border-left: 3px solid var(--accent); }
  .msg.tools { border-left: 3px solid var(--info); }
  .msg.ask { border: 1px solid var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--card)); }
  .msg.done { border-left: 3px solid var(--ok); }
  .msg.error { border-left: 3px solid var(--err); color: var(--err); }
  .msg.plan { border-left: 3px solid var(--warn); }
  .msg.suggest { border-left: 3px solid var(--vscode-charts-purple, #a371f7); }
  .msg.approval { border: 1px solid var(--warn); background: color-mix(in srgb, var(--warn) 10%, var(--card)); }
  .line { color: var(--muted); font-size: 11px; display: flex; align-items: center; gap: 6px; padding: 0 4px; min-width: 0; flex-wrap: wrap; }
  .line .btns { margin-left: auto; display: flex; gap: 4px; }
  .line .txt { flex: 1 1 auto; min-width: 0; }
  .topbar .pill.busy { flex: 0 1 auto; min-width: 0; }
  .hint button { white-space: nowrap; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
  .chip { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip { font-family: var(--mono); font-size: 11px; padding: 1px 6px; border-radius: 5px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .chip.err { background: var(--err); color: #fff; }
  .chip.ok { opacity: .85; }
  .cmd { font-family: var(--mono); background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12)); padding: 2px 6px; border-radius: 5px; display: inline-block; margin: 2px 0; }
  .md p { margin: 4px 0; } .md h1,.md h2,.md h3 { font-size: 13px; margin: 8px 0 4px; } .md ul { margin: 4px 0; padding-left: 18px; } .md code { background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12)); padding: 0 4px; border-radius: 4px; }
  .check { list-style: none; padding-left: 0; margin: 4px 0; }
  .check li { display: flex; gap: 6px; align-items: flex-start; padding: 1px 0; }
  .check li.l1 { padding-left: 16px; } .check li.l2 { padding-left: 32px; } .check li.l3 { padding-left: 48px; }
  .check .box { font-family: var(--mono); color: var(--muted); }
  .check li.done { color: var(--muted); text-decoration: line-through; }
  .btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; align-items: center; min-width: 0; }
  .btns > button { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .badge { font-size: 10px; text-transform: uppercase; letter-spacing: .4px; padding: 1px 6px; border-radius: 4px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }

  /* review */
  .review { margin: 0 10px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); font-size: 12px; }
  .review .row { display: flex; gap: 6px; align-items: center; padding: 2px 0; }
  .review .path { flex: 1; font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .sugItem { border-top: 1px solid var(--border); padding: 5px 0; }
  .sugItem summary { display: flex; align-items: center; gap: 6px; cursor: pointer; list-style: none; min-width: 0; }
  .sugItem summary .t { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sugItem summary .badge { flex: 0 0 auto; white-space: nowrap; }
  .sugItem summary .btns { flex: 0 0 auto; margin: 0; flex-wrap: nowrap; }
  .sugItem summary::-webkit-details-marker { display: none; }
  .sugItem summary::before { content: "▸"; color: var(--muted); font-size: 10px; }
  .sugItem[open] summary::before { content: "▾"; }
  .sugItem pre { margin-top: 4px; max-height: 160px; }

  /* composer */
  .composer { padding: 8px 10px 10px; border-top: 1px solid var(--border); position: relative; }
  .composer .box { display: flex; gap: 6px; align-items: flex-end; }
  .composer.asking { background: color-mix(in srgb, var(--accent) 10%, var(--bg)); border-top: 2px solid var(--accent); }
  .composer.asking textarea { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent); }
  .refbar { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; font-size: 11px; }
  .refbar .sub { color: var(--muted); }
  .att { margin-top: 4px; font-size: 11.5px; line-height: 1.5; }
  a.floc { color: var(--vscode-textLink-foreground, var(--info)); cursor: pointer; text-decoration: none; border-bottom: 1px dotted currentColor; }
  a.floc:hover { color: var(--vscode-textLink-activeForeground, var(--info)); border-bottom-style: solid; }
  code a.floc { color: inherit; }
  .ref { font-family: var(--mono); background: color-mix(in srgb, var(--info) 18%, var(--card)); border: 1px solid color-mix(in srgb, var(--info) 40%, var(--border)); border-radius: 4px; padding: 0 4px; }
  /* pole s přílohou: dá se chytit myší a přetáhnout do okna chatu (skutečný soubor přes dragdrop.py) */
  .ref.draggable { cursor: grab; user-select: none; display: inline-flex; align-items: center; gap: 2px; }
  .ref.draggable:hover { background: color-mix(in srgb, var(--info) 30%, var(--card)); border-color: var(--info); }
  .ref.draggable:active, .ref.draggable.dragging { cursor: grabbing; background: color-mix(in srgb, var(--accent) 25%, var(--card)); border-color: var(--accent); }
  .ref.draggable .ic { width: 11px; height: 11px; opacity: 0.7; }
  .askhint { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 6px; font-size: 12.5px; }
  .askhint b { color: var(--accent); white-space: nowrap; }
  .askhint .q { color: var(--fg); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
  .composer textarea { min-height: 56px; max-height: 200px; resize: vertical; }
  .composer .hint { color: var(--muted); font-size: 11px; margin-top: 4px; display: flex; gap: 8px; align-items: center; }
  .slashbtn { width: 32px; height: 32px; border-radius: 8px; font-family: var(--mono); font-weight: 700; padding: 0; }
  .popup { position: absolute; left: 10px; right: 10px; bottom: 100%; margin-bottom: -6px; background: var(--vscode-editorSuggestWidget-background, var(--card)); border: 1px solid var(--vscode-editorSuggestWidget-border, var(--border)); border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.35); max-height: 260px; overflow: auto; z-index: 5; }
  .popup .it { display: flex; gap: 8px; padding: 6px 10px; cursor: pointer; align-items: baseline; }
  .popup .it.sel, .popup .it:hover { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .popup .it .n { font-family: var(--mono); min-width: 110px; }
  .popup .it .d { color: var(--muted); font-size: 11px; }
  .popup .it.sel .d { color: inherit; opacity: .8; }
  details.log { margin: 0 10px 8px; font-size: 11px; color: var(--muted); }
  details.log pre { max-height: 140px; }
  .empty { color: var(--muted); text-align: center; padding: 30px 12px; font-size: 12.5px; line-height: 1.6; }
  .empty b { color: var(--fg); }
</style></head>
<body>
  <div class="topbar">
    <div class="logo"><span class="dot"></span><span>Whisper</span></div>
    <span id="turnPill" class="pill" hidden></span>
    <span id="planPill" class="pill" hidden>PLAN</span>
    <div class="spacer"></div>
    <button id="modeBtn" class="pill" title="Schvalování příkazů mimo allowlist">ptát se</button>
    <button id="bundlePill" class="pill" title="Doručení svazků (bundle) a příloh do chatu; kliknutím zapnete/vypnete automatické tažení z klávesnice">📎</button>
    <span id="busy" class="pill busy" hidden></span>
    <span class="menu"><button id="menuSuggest" class="ghost small" title="Navrhnout skilly, hooky a úkoly z průběhu" data-ic="lightbulb"></button><button id="menuTranscript" class="ghost small" title="Otevřít záznam průběhu (.whisper/transcript.jsonl)" data-ic="file-text"></button><button id="menuSettings" class="ghost small" title="Otevřít nastavení Whisperu" data-ic="settings"></button></span>
  </div>

  <div id="exceptions" class="sheet" hidden>
    <div class="title">Schvalování příkazů<span class="spacer"></span><button id="exClose" class="ghost small" title="Zavřít" data-ic="x"></button></div>
    <div class="btns"><button id="modeAsk" class="small">ptát se</button><button id="modeAuto" class="small">auto (bez dotazů)</button><span class="sub">zakázané příkazy platí vždy</span></div>
    <details id="exDetails">
      <summary class="sub">Výjimky: příkazy povolené regulárním výrazem <span id="exCount"></span></summary>
      <div id="patterns"></div>
      <div class="btns"><input id="newPattern" type="text" placeholder="^npm (test|run lint)\\b"><button id="addPatternWs" class="small">Přidat (projekt)</button><button id="addPatternGlobal" class="small">Přidat (globálně)</button></div>
    </details>
  </div>

  <div id="chat">
    <div id="stream"></div>
    <div id="review" class="card" hidden></div>
    <div id="suggestions" class="card" hidden>
      <div class="row"><button id="sugToggle" class="ghost small" title="Sbalit/rozbalit">▾</button><b>Návrhy (<span id="sugCount"></span>)</b><span class="spacer"></span><button class="small primary" id="sugAcceptAll" title="Přijmout všechny návrhy">✓ vše</button><button class="small" id="sugRejectAll" title="Zamítnout všechny návrhy">✗ vše</button></div>
      <div id="sugList"></div>
    </div>
    <div id="banner" class="banner" hidden>
      <div class="title"><span class="beacon"></span><span id="bannerTitle"></span></div>
      <div id="bannerSub" class="sub"></div>
      <div id="bannerBtns" class="btns"></div>
    </div>
  </div>

  <div id="composer" class="composer">
    <div id="popup" class="popup" hidden></div>
    <div id="askHint" class="askhint" hidden><b><span data-ic="help-circle"></span> Odpověď pro model:</b><span id="askText" class="q"></span></div>
    <div id="askOptions" class="btns" hidden></div>
    <div id="refbar" class="refbar" hidden><span class="sub">Kontext:</span><button id="refFile" class="small ghost" title="Přidat odkaz na soubor otevřený v editoru" data-ic="plus" data-label="soubor"></button><button id="refSel" class="small ghost" hidden title="Přidat odkaz na výběr v editoru" data-ic="plus" data-label="výběr"></button><span id="refHint" class="sub"></span></div>
    <div class="box">
      <button id="slash" class="slashbtn" title="Příkazy a skilly">/</button>
      <textarea id="input" rows="2" placeholder="Zadejte úkol… (/ pro příkazy, Enter odešle, Shift+Enter nový řádek)"></textarea>
      <button id="send" class="primary" title="Odeslat (Enter)" data-ic="send"></button>
    </div>
    <div class="hint"><span id="hint"></span><span class="spacer"></span><button id="stopBtn" class="ghost small" hidden data-ic="square" data-label="zrušit"></button><button id="undoBtn" class="ghost small" hidden data-ic="undo" data-label="undo"></button><button id="resendBtn" class="ghost small" hidden title="Znovu poslat celý kontext (pro nový chat)" data-ic="refresh" data-label="kontext znovu"></button></div>
  </div>

  <details class="log"><summary>Log</summary><pre id="log"></pre></details>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  // Každý požadavek dostane reqId; do potvrzení (ack) z extensionu panel ukazuje „⏳ …“ v horní liště a
  // kliknuté tlačítko je zamčené, aby bylo hned vidět, že se něco děje, a nešlo to spustit dvakrát.
  const LABELS = { send: "Odesílám zadání", copyAgain: "Kopíruji prompt do schránky", showPrompt: "Otevírám prompt", pasteClip: "Beru odpověď ze schránky", resend: "Skládám celý kontext", correction: "Posílám opravný prompt", suggest: "Připravuji návrhy", drag: "Spouštím tažení přílohy", dragMouse: "Táhněte do okna chatu a pusťte", interrupt: "Přerušuji akce", stop: "Ruším úkol", undo: "Vracím poslední kolo", approve: "Zpracovávám rozhodnutí", suggestion: "Ukládám návrh", suggestionsAll: "Ukládám návrhy", setDelivery: "Měním doručení svazků", setMode: "Měním schvalování", autoAll: "Přepínám na auto", transcript: "Otevírám záznam", reloadSkills: "Načítám skilly", settings: "Otevírám nastavení", reviewNext: "Otevírám změny", acceptAll: "Přijímám změny", rejectAll: "Zamítám změny", acceptFile: "Přijímám soubor", rejectFile: "Zamítám soubor", openDiff: "Otevírám diff", addPattern: "Ukládám výjimku", removePattern: "Mažu výjimku" };
  let reqSeq = 0;
  const pending = new Map();
  let lastClicked = null;
  let lastClickAt = 0;
  document.addEventListener("click", (e) => { const b = e.target && e.target.closest ? e.target.closest("button") : null; if (b) { lastClicked = b; lastClickAt = Date.now(); } }, true);
  function showBusy(html, cls) {
    const el = $("busy"); el.innerHTML = html; el.className = "pill busy " + (cls || ""); el.hidden = false;
  }
  function send(type, extra) {
    if (type === "ready") return vscode.postMessage({ type });
    const reqId = ++reqSeq;
    const btn = Date.now() - lastClickAt < 300 ? lastClicked : null;
    if (btn) { btn.disabled = true; btn.classList.add("busy"); }
    const label = LABELS[type] || "Pracuji";
    pending.set(reqId, { btn, label, timer: setTimeout(() => finish(reqId, "bez odpovědi"), 20000) });
    showBusy(ic("loader", "spin") + " " + esc(label) + "…");
    vscode.postMessage({ type, reqId, ...(extra || {}) });
  }
  /**
   * Pole s přílohou jde chytit myší: webview soubor ven předat neumí, takže po stisknutí tlačítka
   * a malém posunu (aby prosté kliknutí drag nespustilo) o to požádáme extension. Ta spustí
   * dragdrop.py --mouse, který na už držené tlačítko naváže skutečný OLE drag se souborem;
   * uživatel dotáhne do okna chatu a pustí. Vlastní HTML5 drag se ruší, aby se nepletl.
   */
  function armDrag(el) {
    el.ondragstart = (e) => e.preventDefault();
    el.onmousedown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      let armed = false;
      const move = (ev) => {
        if (armed || Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 4) return;
        armed = true;
        el.classList.add("dragging");
        send("dragMouse", { path: el.dataset.drag });
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        setTimeout(() => el.classList.remove("dragging"), 400);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    };
  }

  function finish(reqId, error) {
    const p = pending.get(reqId); if (!p) return;
    pending.delete(reqId); clearTimeout(p.timer);
    if (p.btn) { p.btn.disabled = false; p.btn.classList.remove("busy"); }
    if (pending.size) return;
    showBusy(error ? ic("x") + " " + esc(p.label) + ": " + esc(error) : ic("check") + " " + esc(p.label), error ? "err" : "ok");
    setTimeout(() => { if (!pending.size) $("busy").hidden = true; }, error ? 5000 : 1200);
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const kb = (n) => (n / 1000).toFixed(1) + " k";
  // ikony (Lucide, 24px mřížka, tenká linka): jednotný moderní styl místo emoji, barva podle okolního textu
  const ICONS = {
    lightbulb: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/>',
    "file-text": '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    settings: '<path d="M21 4h-7"/><path d="M10 4H3"/><path d="M21 12h-9"/><path d="M8 12H3"/><path d="M21 20h-5"/><path d="M12 20H3"/><path d="M14 2v4"/><path d="M8 10v4"/><path d="M16 18v4"/>',
    paperclip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    move: '<path d="M5 9 2 12l3 3"/><path d="m9 5 3-3 3 3"/><path d="m15 19-3 3-3-3"/><path d="m19 9 3 3-3 3"/><path d="M2 12h20"/><path d="M12 2v20"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    square: '<rect width="14" height="14" x="5" y="5" rx="2"/>',
    undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
    refresh: '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
    "help-circle": '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    clipboard: '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
    bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
    "list-checks": '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
    "list-todo": '<rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
    "check-circle": '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>',
    "alert-circle": '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    "square-check": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>',
    "square-empty": '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  };
  const ic = (name, cls) => '<svg class="ic' + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || "") + "</svg>";
  for (const el of document.querySelectorAll("[data-ic]")) el.innerHTML = ic(el.dataset.ic) + (el.dataset.label ? " " + el.dataset.label : "");
  let state = { items: [], commands: [], approvals: { mode: "ask", pending: [], history: [] }, review: [], log: [] };
  let lastCount = -1;
  let wasAsking = false;

  // ---------- jednoduchý markdown ----------
  function md(text) {
    const lines = String(text ?? "").split("\\n");
    let html = ""; let inList = false; let inPre = false; let pre = [];
    // cesty k souborům (i s :řádkem) se mění v odkazy, které soubor otevřou na daném místě
    const linkFiles = (html) => html.replace(/(^|[\\s(>"'\\[])([\\w.\\-]+(?:\\/[\\w.\\-]+)+\\.[a-zA-Z0-9]{1,8})(?::(\\d+))?(?::(\\d+))?/g,
      (m, pre, path, line, col) => pre + '<a class="floc" data-path="' + path + '" data-line="' + (line || "") + '" data-col="' + (col || "") + '" title="Otevřít v editoru">' + path + (line ? ":" + line : "") + (col ? ":" + col : "") + "</a>");
    const inline = (s) => linkFiles(esc(s).replace(/\`([^\`]+)\`/g, "<code>$1</code>").replace(/\\*\\*([^*]+)\\*\\*/g, "<b>$1</b>"));
    for (const raw of lines) {
      if (raw.trim().startsWith("\`\`\`")) { if (inPre) { html += "<pre>" + esc(pre.join("\\n")) + "</pre>"; pre = []; } inPre = !inPre; continue; }
      if (inPre) { pre.push(raw); continue; }
      const li = raw.match(/^\\s*[-*]\\s+(.*)$/);
      if (li) { if (!inList) { html += "<ul>"; inList = true; } html += "<li>" + inline(li[1]) + "</li>"; continue; }
      if (inList) { html += "</ul>"; inList = false; }
      const h = raw.match(/^(#{1,3})\\s+(.*)$/);
      if (h) { html += "<h" + h[1].length + ">" + inline(h[2]) + "</h" + h[1].length + ">"; continue; }
      if (raw.trim() === "") continue;
      html += "<p>" + inline(raw) + "</p>";
    }
    if (inList) html += "</ul>";
    if (inPre) html += "<pre>" + esc(pre.join("\\n")) + "</pre>";
    return '<div class="md">' + html + "</div>";
  }
  function checklist(text) {
    const items = [];
    for (const raw of String(text ?? "").split("\\n")) {
      const m = raw.match(/^(\\s*)[-*]\\s+\\[([ xX])\\]\\s*(.*)$/);
      if (!m) continue;
      const level = Math.min(3, Math.floor(m[1].replace(/\\t/g, "  ").length / 2));
      const done = m[2] !== " ";
      items.push('<li class="l' + level + (done ? " done" : "") + '"><span class="box">' + ic(done ? "square-check" : "square-empty") + "</span><span>" + esc(m[3]) + "</span></li>");
    }
    return '<ul class="check">' + items.join("") + "</ul>";
  }

  // ---------- render ----------
  const STATE = {
    waitingForReply: ["waiting", "Čekám na odpověď modelu", "Prompt je ve schránce. Vložte ho do chatu, zkopírujte odpověď modelu (Ctrl+C) a Whisper ji sám převezme."],
    executing: ["executing", "Provádím akce", "Čtu soubory, zapisuji změny, spouštím příkazy…"],
    awaitingUser: ["asking", "Model se ptá", "Odpovězte do pole níže."],
    composing: ["executing", "Sestavuji prompt", ""],
    done: ["done", "Úkol dokončen", "Zadejte další úkol, nebo /suggest pro návrhy z průběhu."],
  };

  function render() {
    const s = state.session;
    const active = s && s.state !== "idle";
    $("turnPill").hidden = !active; if (active) { $("turnPill").textContent = "kolo " + s.turn; $("turnPill").title = "Číslo kola"; }
    $("planPill").hidden = !(active && s.planMode);
    const pat = (state.approvals.patterns || []).length;
    $("modeBtn").textContent = (state.approvals.mode === "auto" ? "auto" : "ptát se") + (pat ? " · " + pat : "");
    $("modeBtn").title = "Schvalování příkazů" + (pat ? " · výjimek: " + pat : "") + " (klikněte pro nastavení)";
    $("modeBtn").className = "pill" + (state.approvals.mode === "auto" ? " on" : "");
    // doručení svazků: drag = příloha se po zkopírování promptu hned táhne do chatu (Alt+Tab, Enter)
    const drag = state.delivery === "drag";
    $("bundlePill").innerHTML = ic("paperclip") + " " + (drag ? "drag" : state.delivery === "file" ? "soubor" : "historie");
    $("bundlePill").title = drag
      ? "Bundle se automaticky táhne do chatu (Alt+Tab do chatu, Enter pustí, Esc zruší). Kliknutím vypnete (svazek půjde do historie schránky)."
      : "Bundle jde " + (state.delivery === "file" ? "jako soubor ve schránce" : "do historie schránky (Win+V)") + ". Kliknutím zapnete automatické tažení do chatu z klávesnice (vyžaduje Python s pywin32).";
    $("bundlePill").className = "pill" + (drag ? " on" : "");
    renderExceptions();
    renderSuggestions();
    $("stopBtn").hidden = !(active && s.state !== "done");
    $("undoBtn").hidden = !(active);
    $("resendBtn").hidden = !(active && s.state !== "done");

    const banner = $("banner");
    if (active && STATE[s.state]) {
      const [cls, title, sub] = STATE[s.state];
      banner.hidden = false; banner.className = "banner " + cls;
      const sent = state.promptPhase === "sent";
      $("bannerTitle").textContent = (s.state === "waitingForReply" ? (sent ? "Čekám na odpověď modelu" : "Prompt je ve schránce, vložte ho do chatu") + " · kolo " + s.turn : title);
      if (s.state === "waitingForReply") {
        const att = s.attachments || [];
        const fileMode = s.reply && s.reply.mode === "file";
        const after = fileMode
          ? "Prompt byl vložen. Model má odpovědět souborem whisper-reply-" + s.turn + ".xml: stáhněte ho do " + (s.reply.dir || "složky stahování") + ", Whisper ho převezme (zkopírovanou odpověď Ctrl+C bere také)."
          : "Prompt byl vložen. Až model odpoví, zkopírujte odpověď (Ctrl+C), Whisper ji sám převezme.";
        const base = (sent ? after : "Vložte prompt do chatu (Ctrl+V); Whisper pozná, že byl vložen.") + " (" + kb(s.promptChars) + " znaků)";
        // přílohy (svazky souborů) musí být vidět, jinak uživatel neví, že má vložit i je
        $("bannerSub").innerHTML = esc(base) + (att.length
          ? '<div class="att">' + ic("paperclip") + esc(att.length > 1 ? att.length + " přílohy" : "příloha") + ": " +
            att.map((a) => '<span class="ref draggable" data-drag="' + esc(String(a.path || a.name || a)) + '" title="Přetáhněte myší do okna chatu (nebo klikněte a použijte tlačítko níže)">' + ic("move") + esc(String(a.name || a)) + "</span>" +
              (a.chars ? ' <span class="sub">(' + kb(a.chars) + (a.ageMin != null ? ", " + (a.ageMin < 1 ? "právě teď" : a.ageMin < 60 ? "před " + a.ageMin + " min" : "před " + Math.round(a.ageMin / 60) + " h") : "") + ")</span>" : "") +
              (a.ageMin > 30 ? ' <span class="badge" title="Soubor je starší než půl hodiny: nový svazek se v tomto kole nevytvořil">' + ic("alert") + 'starý soubor</span>' : "")).join(", ") +
            (s.delivery === "drag"
              ? '<br><span class="sub">Přílohu chyťte myší a přetáhněte do okna chatu, nebo ji táhněte z klávesnice: <b>Alt+Tab</b> do chatu (kurzor skočí do okna), <b>Enter</b> pustí, Esc zruší; pak Ctrl+V vloží prompt.</span>'
              : s.historyItems && s.historyItems.length
                ? '<br><span class="sub">Vložte Ctrl+V (prompt) a pak svazek z historie schránky: <b>Win+V</b>.</span>'
                : '<br><span class="sub">Přiloženo jako soubor ve schránce; jedno Ctrl+V vloží prompt i přílohu.</span>') + "</div>"
          : "");
      } else $("bannerSub").textContent = sub;
      const b = $("bannerBtns"); b.innerHTML = "";
      if (s.state === "waitingForReply") {
        b.innerHTML = '<button class="primary small" data-act="copyAgain">' + ic("copy") + ' Zkopírovat prompt znovu</button><button class="small" data-act="showPrompt">Zobrazit prompt</button><button class="small" data-act="pasteClip">Vzít odpověď ze schránky</button><button class="small" data-act="resend" title="Pro nový chat: preambule + shrnutí dosavadního průběhu">↻ Poslat celý kontext znovu</button><button class="ghost small" data-act="correction" title="Když model odpověděl bez bloku akcí a nebyla to otázka">Poslat opravný prompt</button>' +
          ((s.attachments || []).length ? '<button class="small" data-act="drag" title="Přetáhne přílohu do chatu z klávesnice: Alt+Tab do chatu, Enter pustí, Esc zruší (vyžaduje Python s pywin32)">' + ic("move") + ' Táhnout přílohu do chatu</button>' : "");
      } else if (s.state === "awaitingUser") {
        b.innerHTML = '<button class="small" data-act="focus">Odpovědět</button>';
      } else if (s.state === "executing") {
        const cur = state.current;
        $("bannerSub").innerHTML = cur
          ? "Akce " + cur.index + "/" + cur.total + ": <span class='cmd'>" + esc(cur.tool) + (cur.target ? " " + esc(cur.target) : "") + "</span> <span id='elapsed' data-start='" + cur.startedAt + "'></span>"
          : esc(sub);
        b.innerHTML = '<button class="small" data-act="interrupt" title="Ukončí běžící příkaz, zbylé akce přeskočí a modelu pošle, co proběhlo a kde to stálo">■ Přerušit akce</button>';
      }
      for (const x of b.querySelectorAll("button")) x.onclick = () => x.dataset.act === "focus" ? $("input").focus() : send(x.dataset.act);
    } else banner.hidden = true;

    // chat
    const chat = $("chat");
    const stick = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 40;
    const parts = [];
    if (!active && state.items.length === 0) {
      parts.push('<div class="empty"><b>Whisper Agent</b><br>Kódovací agent, který s modelem mluví přes schránku.<br>Napište úkol dole, nebo začněte <code>/</code> pro příkazy a skilly.</div>');
    }
    for (const it of state.items) parts.push(renderItem(it, s));
    for (const a of state.approvals.pending) parts.push(renderApproval(a));
    $("stream").innerHTML = parts.join("");
    for (const x of chat.querySelectorAll("[data-act]")) x.onclick = onAct;
    for (const a of chat.querySelectorAll("a.floc")) a.onclick = (e) => { e.preventDefault(); send("openFile", { path: a.dataset.path, text: a.dataset.line || "", always: a.dataset.col || "" }); };
    for (const d of chat.querySelectorAll("[data-drag]")) armDrag(d);
    // banner i karty jsou uvnitř #chat a dorenderují se níž, proto rolujeme až po jejich vykreslení
    if (stick || state.items.length !== lastCount) requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; });
    lastCount = state.items.length;

    // review
    const rv = $("review");
    rv.hidden = state.review.length === 0;
    if (state.review.length) {
      rv.innerHTML = "<div class='row'><b>Změny ke schválení (" + state.review.length + ")</b><span class='spacer'></span><button class='small primary' data-act='reviewNext'>Projít</button><button class='small' data-act='acceptAll'>Přijmout vše</button><button class='small' data-act='rejectAll'>Zamítnout vše</button></div>" +
        state.review.map((p) => "<div class='row'><span class='path' title='" + esc(p.path) + "'>" + (p.kind === "create" ? "＋" : p.kind === "delete" ? "－" : "～") + " " + esc(p.path) + " <span class='badge'>" + p.hunks + "</span></span><button class='small' data-act='acceptFile' data-path='" + esc(p.path) + "'>✓</button><button class='small' data-act='rejectFile' data-path='" + esc(p.path) + "'>✗</button>" + (p.kind !== "delete" ? "<button class='small' data-act='openDiff' data-path='" + esc(p.path) + "'>diff</button>" : "") + "</div>").join("");
      for (const x of rv.querySelectorAll("[data-act]")) x.onclick = onAct;
    }

    $("hint").textContent = !active ? "Enter odešle, / příkazy a skilly" : s.state === "awaitingUser" ? "Napište odpověď pro model a odešlete Enterem" : s.state === "waitingForReply" ? "Poznámky napsané teď se přiloží k dalšímu promptu; vložená odpověď modelu se rozpozná sama" : s.state === "done" ? "Další úkol, nebo /suggest" : "";
    // otázka modelu: zvýrazněný vstup s textem otázky a fokusem
    const asking = !!(active && s.state === "awaitingUser");
    $("composer").className = "composer" + (asking ? " asking" : "");
    $("askHint").hidden = !asking;
    if (asking) {
      $("askText").textContent = (s.pendingQuestion || "").replace(/\\s+/g, " ").slice(0, 300);
      const o = s.pendingOptions || [];
      const box = $("askOptions");
      box.hidden = o.length === 0;
      if (o.length && !wasAsking) {
        box.innerHTML = s.pendingMulti
          ? o.map((x, i) => '<label class="small"><input type="checkbox" data-opt="' + esc(x) + '"> ' + esc(x) + "</label>").join("") + '<button class="primary small" id="sendMulti">Odeslat výběr</button>'
          : o.map((x) => '<button class="small" data-act="pick" data-opt="' + esc(x) + '">' + esc(x) + "</button>").join("");
        for (const x of box.querySelectorAll("[data-act=pick]")) x.onclick = () => pickOption(x.dataset.opt);
        const sm = $("sendMulti"); if (sm) sm.onclick = () => { const picked = [...box.querySelectorAll("input:checked")].map((c) => c.dataset.opt); if (picked.length) send("send", { text: picked.join(", ") }); };
      }
      input.placeholder = o.length ? "…nebo napište vlastní odpověď (Enter odešle)" : "Odpověď pro model… (Enter odešle)";
      if (document.activeElement !== input && !wasAsking && !o.length) input.focus();
    } else {
      $("askOptions").hidden = true;
      input.placeholder = "Zadejte úkol… (/ pro příkazy, Enter odešle, Shift+Enter nový řádek)";
    }
    wasAsking = asking;
    // lišta kontextu: co je otevřené v editoru a co už je odkázané v textu
    const ed = state.editor;
    $("refbar").hidden = !ed;
    if (ed) {
      const short = (ed.path || "").split("/").pop();
      $("refFile").textContent = "＋ " + (short || "soubor");
      $("refFile").title = "Přidat odkaz na " + (ed.path || "aktivní soubor");
      $("refSel").hidden = !ed.selection;
      if (ed.selection) $("refSel").textContent = "＋ výběr " + ed.selection;
      const used = input.value.match(/#[^\\s#]+/g) || [];
      $("refHint").innerHTML = used.length ? used.map((r) => '<span class="ref">' + esc(r) + "</span>").join(" ") : "napište # pro odkaz na soubor";
    }
    $("log").textContent = state.log.join("\\n");
  }

  function renderItem(it, s) {
    const turn = it.turn ? '<span class="badge">kolo ' + it.turn + "</span>" : "";
    switch (it.kind) {
      case "task": return '<div class="msg user"><div class="head">' + ic("user") + '<b>Vy</b>' + (it.data && it.data.planMode ? '<span class="badge">plan</span>' : "") + '</div>' + md(it.text) + "</div>";
      case "note": return '<div class="msg user"><div class="head">' + ic("user") + '<b>Vy</b><span>poznámka k dalšímu promptu</span></div>' + md(it.text) + "</div>";
      case "answer": return '<div class="msg user"><div class="head">' + ic("user") + '<b>Vy</b><span>odpověď</span></div>' + md(it.text) + "</div>";
      case "dialog": {
        const d = it.data || {};
        if (d.from === "user") return '<div class="msg user"><div class="head">' + ic("user") + '<b>Vy</b><span>napsáno přímo v chatu</span></div>' + md(it.text) + "</div>";
        return '<div class="msg ask"><div class="head">' + ic("message") + '<b>Model' + (d.live ? " se ptá v chatu" : " se ptal v chatu") + "</b>" + turn + "</div>" + md(it.text) + (d.live ? '<div class="sub">Odpovězte přímo v chatu a zkopírujte jeho další odpověď.</div>' : "") + "</div>";
      }
      case "prompt": {
        const att = it.data && it.data.attachments && it.data.attachments.length ? " · " + ic("paperclip") + it.data.attachments.map((a) => esc(String(a).split("/").pop())).join(", ") : "";
        return '<div class="line"><span class="txt">' + ic("clipboard") + 'kolo ' + it.turn + " · prompt ve schránce (" + kb(it.data ? it.data.chars : 0) + (it.data && it.data.mode === "file" ? ", soubory" : "") + ")" + att + '</span><span class="btns"><button class="ghost small" data-act="copyAgain">znovu</button><button class="ghost small" data-act="showPrompt">zobrazit</button></span></div>';
      }
      case "status": return '<div class="msg model"><div class="head">' + ic("bot") + '<b>Model</b>' + turn + "</div>" + md(it.text) + "</div>";
      case "actions": return '<div class="msg tools"><div class="head">' + ic("terminal") + '<b>Akce</b>' + turn + '</div><div class="chips">' + (it.data || []).map((a) => '<span class="chip">' + esc(a.tool) + (a.target ? " " + esc(a.target) : "") + "</span>").join("") + "</div></div>";
      case "results": return '<div class="msg tools"><div class="head">' + ic("list-checks") + '<b>Výsledky</b>' + turn + '</div><div class="chips">' + (it.data || []).map((r) => '<span class="chip ' + (r.status === "ok" ? "ok" : "err") + '">' + (r.status === "ok" ? ic("check") : ic("x")) +" " + esc(r.tool) + (r.target ? " " + esc(String(r.target).slice(0, 60)) : "") + (r.meta && r.meta.exit !== undefined ? " exit " + esc(r.meta.exit) : "") + (r.meta && r.meta.hunks ? " " + esc(r.meta.hunks) : "") + "</span>").join("") + "</div></div>";
      case "plan": return '<div class="msg plan"><div class="head">' + ic("list-todo") + '<b>Plán</b>' + turn + "</div>" + checklist(it.text) + "</div>";
      case "ask": {
        const o = (it.data && it.data.options) || [];
        const live = s && s.state === "awaitingUser" && s.pendingQuestion === it.text;
        const opts = o.length && live ? '<div class="btns">' + o.map((x) => '<button class="small" data-act="pick" data-opt="' + esc(x) + '">' + esc(x) + "</button>").join("") + (it.data.multi ? '<span class="badge">více možností: vyberte dole</span>' : "") + "</div>" : "";
        return '<div class="msg ask"><div class="head">' + ic("help-circle") + '<b>Model se ptá</b></div>' + md(it.text) + opts + "</div>";
      }
      case "done": return '<div class="msg done"><div class="head">' + ic("check-circle") + '<b>Hotovo</b></div>' + md(it.text) + "</div>";
      case "error": return '<div class="msg error"><div class="head">' + ic("alert-circle") + '<b>Chyba</b>' + turn + "</div>" + esc(it.text) + "</div>";
      case "undo": return '<div class="line"><span class="txt">' + ic("undo") + esc(it.text) + "</span></div>";
      case "info": return '<div class="line"><span class="txt">' + ic(it.data && it.data.icon ? it.data.icon : "info") + esc(it.text) + "</span></div>";
      case "suggestion": {
        const d = it.data || {};
        const live = s && s.suggestions ? s.suggestions.find((x) => x.id === d.id) : null;
        const decision = (live && live.decision) || d.decision;
        const dup = (live && live.duplicate) || d.duplicate;
        return '<div class="line"><span class="txt">' + ic("lightbulb") + 'návrh <span class="badge">' + esc(d.kind) + "</span> " + (d.update ? '<span class="badge" title="úprava existující položky">upravuje ' + esc(d.update) + "</span> " : "") + esc(d.title) +
          (dup ? ' <span class="badge" title="stejná věc už existuje, návrh se přeskočil">duplikát</span>' : decision ? ' <span class="badge">' + (decision === "approved" ? "přijato" : "zamítnuto") + "</span>" : " · čeká v sekci Návrhy") + "</span></div>";
      }
      default: return "";
    }
  }

  function renderApproval(a) {
    const isCmd = a.kind === "command";
    const suggested = isCmd ? "^" + esc(a.text.split(/\\s+/).slice(0, 2).map((w) => w.replace(/[.*+?^$(){}|[\\]\\\\]/g, "\\\\$&")).join("\\\\s+")) + "\\\\b" : "";
    return '<div class="msg approval" data-approval="' + esc(a.id) + '"><div class="head">' + ic(isCmd ? "terminal" : "trash") + '<b>' + (isCmd ? "Spustit příkaz?" : "Smazat soubor?") + "</b>" + (a.cwd && a.cwd !== "." ? '<span>v ' + esc(a.cwd) + "</span>" : "") + '</div><span class="cmd">' + esc(a.text) + "</span>" +
      '<div class="btns"><button class="primary small" data-act="allow" data-id="' + esc(a.id) + '">Povolit</button><button class="small" data-act="deny" data-id="' + esc(a.id) + '">Zamítnout</button>' +
      (isCmd ? '<button class="small" data-act="allowAlways" data-id="' + esc(a.id) + '">Povolit vždy (regex) ▸</button><button class="small" data-act="autoAll" title="Přepne schvalování na auto a povolí čekající příkazy">Auto (dál se neptat)</button>' : "") + "</div>" +
      (isCmd ? '<div class="btns" data-always="' + esc(a.id) + '" hidden><input type="text" value="' + suggested + '" placeholder="regulární výraz na celý příkaz"><button class="primary small" data-act="allowAlwaysGo" data-id="' + esc(a.id) + '">Uložit a povolit</button></div>' : "") + "</div>";
  }

  function pickOption(opt) {
    if (!opt) return;
    if (state.session && state.session.pendingMulti) {
      const cb = $("askOptions").querySelector('input[data-opt="' + CSS.escape(opt) + '"]');
      if (cb) cb.checked = !cb.checked;
      return;
    }
    send("send", { text: opt });
  }

  function onAct(e) {
    const b = e.currentTarget; const act = b.dataset.act; const id = b.dataset.id;
    if (act === "allow") send("approve", { id, allow: true });
    else if (act === "deny") send("approve", { id, allow: false });
    else if (act === "allowAlways") { const row = document.querySelector('[data-always="' + id + '"]'); if (row) { row.hidden = !row.hidden; row.querySelector("input").focus(); } }
    else if (act === "allowAlwaysGo") { const row = document.querySelector('[data-always="' + id + '"]'); send("approve", { id, allow: true, always: row.querySelector("input").value }); }
    else if (act === "pick") pickOption(b.dataset.opt);
    else if (act === "sugYes") send("suggestion", { id, approve: true });
    else if (act === "sugNo") send("suggestion", { id, approve: false });
    else if (b.dataset.path) send(act, { path: b.dataset.path });
    else send(act);
  }

  // ---------- composer + lomítka ----------
  const input = $("input"); const popup = $("popup"); let sel = 0; let popupItems = []; let refItems = []; let popupMode = "cmd";
  function currentSlash() {
    const v = input.value; const pos = input.selectionStart;
    const before = v.slice(0, pos);
    const m = before.match(/(^|\\s)\\/([\\w.-]*)$/);
    return m ? { prefix: m[2], start: pos - m[2].length - 1 } : null;
  }
  function currentRef() {
    const v = input.value; const pos = input.selectionStart;
    const m = v.slice(0, pos).match(/(^|\\s)#([^\\s#]*)$/);
    return m ? { prefix: m[2], start: pos - m[2].length - 1 } : null;
  }
  function showRefPopup(prefix) {
    const p = (prefix || "").toLowerCase();
    const special = [
      { name: "file", desc: "aktivní soubor v editoru" },
      { name: "selection", desc: "výběr v editoru" },
    ].filter((x) => x.name.startsWith(p));
    const files = (state.files || []).filter((f) => f.toLowerCase().includes(p)).slice(0, 40);
    // přesnější shody (název souboru) napřed
    files.sort((a, b) => {
      const an = a.split("/").pop().toLowerCase().startsWith(p) ? 0 : 1;
      const bn = b.split("/").pop().toLowerCase().startsWith(p) ? 0 : 1;
      return an - bn || a.length - b.length;
    });
    refItems = [...special.map((x) => ({ ref: x.name, desc: x.desc })), ...files.slice(0, 14).map((f) => ({ ref: f, desc: "" }))].slice(0, 14);
    if (!refItems.length) { popup.hidden = true; return; }
    sel = Math.min(sel, refItems.length - 1);
    popupMode = "ref";
    popup.innerHTML = refItems.map((c, i) => '<div class="it' + (i === sel ? " sel" : "") + '" data-i="' + i + '"><span class="n">#' + esc(c.ref) + '</span><span class="d">' + esc(c.desc) + "</span></div>").join("");
    for (const x of popup.querySelectorAll(".it")) x.onclick = () => acceptRef(Number(x.dataset.i));
    popup.hidden = false;
  }
  function acceptRef(i) {
    const c = refItems[i]; if (!c) return;
    const cr = currentRef(); if (!cr) return;
    input.value = input.value.slice(0, cr.start) + "#" + c.ref + " " + input.value.slice(input.selectionStart);
    popup.hidden = true; popupMode = "cmd"; input.focus();
  }
  function showPopup(prefix, forceAll) {
    const p = (prefix || "").toLowerCase();
    popupItems = state.commands.filter((c) => forceAll || c.name.toLowerCase().startsWith(p)).sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "builtin" ? -1 : 1).slice(0, 14);
    if (!popupItems.length) { popup.hidden = true; return; }
    sel = Math.min(sel, popupItems.length - 1);
    popupMode = "cmd";
    popup.innerHTML = popupItems.map((c, i) => '<div class="it' + (i === sel ? " sel" : "") + '" data-i="' + i + '"><span class="n">/' + esc(c.name) + '</span><span class="d">' + esc(c.description) + (c.kind === "skill" ? " · skill" : "") + "</span></div>").join("");
    for (const x of popup.querySelectorAll(".it")) x.onclick = () => accept(Number(x.dataset.i));
    popup.hidden = false;
  }
  function accept(i) {
    const c = popupItems[i]; if (!c) return;
    const cs = currentSlash();
    if (cs) { input.value = input.value.slice(0, cs.start) + "/" + c.name + " " + input.value.slice(input.selectionStart); }
    else { input.value = "/" + c.name + " " + input.value; }
    popup.hidden = true; input.focus();
  }
  input.addEventListener("input", () => {
    const cr = currentRef();
    if (cr) { sel = 0; showRefPopup(cr.prefix); return; }
    const cs = currentSlash();
    if (cs) { sel = 0; showPopup(cs.prefix); } else popup.hidden = true;
  });
  input.addEventListener("keydown", (e) => {
    if (!popup.hidden) {
      const n = popupMode === "ref" ? refItems.length : popupItems.length;
      const redraw = () => popupMode === "ref" ? showRefPopup(currentRef()?.prefix) : showPopup(currentSlash()?.prefix, !currentSlash());
      if (e.key === "ArrowDown") { sel = (sel + 1) % n; redraw(); e.preventDefault(); return; }
      if (e.key === "ArrowUp") { sel = (sel - 1 + n) % n; redraw(); e.preventDefault(); return; }
      if (e.key === "Tab" || e.key === "Enter") { popupMode === "ref" ? acceptRef(sel) : accept(sel); e.preventDefault(); return; }
      if (e.key === "Escape") { popup.hidden = true; e.preventDefault(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  function submit() { const t = input.value.trim(); if (!t) return; send("send", { text: t }); input.value = ""; popup.hidden = true; }
  function addRef(token) {
    const v = input.value;
    if (v.includes("#" + token)) { input.focus(); return; }
    input.value = (v ? v.replace(/\s*$/, "") + " " : "") + "#" + token + " ";
    input.focus(); popup.hidden = true;
  }
  $("refFile").onclick = () => addRef((state.editor && state.editor.path) || "file");
  $("refSel").onclick = () => addRef("selection");
  $("send").onclick = submit;
  $("slash").onclick = () => { if (!popup.hidden) { popup.hidden = true; return; } sel = 0; showPopup("", true); input.focus(); };
  $("modeBtn").onclick = () => { $("exceptions").hidden = !$("exceptions").hidden; };
  $("bundlePill").onclick = () => send("setDelivery", { text: state.delivery === "drag" ? "history" : "drag" });
  $("exClose").onclick = () => { $("exceptions").hidden = true; };
  $("modeAsk").onclick = () => send("setMode", { mode: "ask" });
  $("modeAuto").onclick = () => send("setMode", { mode: "auto" });
  const addPattern = (global) => { const v = $("newPattern").value.trim(); if (!v) return; send("addPattern", { text: v, approve: global }); $("newPattern").value = ""; };
  $("addPatternWs").onclick = () => addPattern(false);
  $("addPatternGlobal").onclick = () => addPattern(true);
  let sugOpen = true;
  $("sugToggle").onclick = () => { sugOpen = !sugOpen; renderSuggestions(); };
  $("sugAcceptAll").onclick = () => send("suggestionsAll", { approve: true });
  $("sugRejectAll").onclick = () => send("suggestionsAll", { approve: false });
  function renderSuggestions() {
    const all = (state.session && state.session.suggestions) || [];
    const pending = all.filter((x) => !x.decision);
    const box = $("suggestions");
    box.hidden = pending.length === 0;
    if (!pending.length) return;
    $("sugCount").textContent = pending.length;
    $("sugToggle").textContent = sugOpen ? "▾" : "▸";
    const list = $("sugList");
    if (!sugOpen) { list.innerHTML = ""; return; }
    const groups = [["global", "Agent globálně (všechny projekty)"], ["project", "Tento projekt"]];
    list.innerHTML = groups.map(([scope, label]) => {
      const items = pending.filter((x) => (x.scope || "project") === scope);
      if (!items.length) return "";
      return '<div class="sub" style="margin-top:6px"><b>' + label + "</b></div>" + items.map((x) =>
        '<details class="sugItem"><summary><span class="badge">' + esc(x.kind) + "</span>" + (x.update ? '<span class="badge" title="úprava existující položky">upravuje ' + esc(x.update) + "</span>" : "") + '<span class="t" title="' + esc(x.title) + '">' + esc(x.title) + "</span>" +
        '<span class="btns" style="margin:0 0 0 auto"><button class="small primary" data-sug="' + esc(x.id) + '" data-ok="1" title="Přijmout">✓</button><button class="small" data-sug="' + esc(x.id) + '" data-ok="0" title="Zamítnout">✗</button></span></summary><pre>' + esc(x.body) + "</pre></details>").join("");
    }).join("");
    for (const b of list.querySelectorAll("[data-sug]")) b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); send("suggestion", { id: b.dataset.sug, approve: b.dataset.ok === "1" }); };
  }

  function renderExceptions() {
    $("modeAsk").className = "small" + (state.approvals.mode === "ask" ? " primary" : "");
    $("modeAuto").className = "small" + (state.approvals.mode === "auto" ? " primary" : "");
    const list = state.approvals.patterns || [];
    $("patterns").innerHTML = list.length ? list.map((p) => '<div class="line"><span class="cmd">' + esc(p.pattern) + '</span><span class="badge">' + (p.scope === "global" ? "globální" : "projekt") + '</span><span class="btns"><button class="ghost small" data-rm="' + esc(p.pattern) + '" data-global="' + (p.scope === "global") + '">✗</button></span></div>').join("") : '<div class="sub">zatím žádné výjimky</div>';
    for (const b of $("patterns").querySelectorAll("[data-rm]")) b.onclick = () => send("removePattern", { text: b.dataset.rm, approve: b.dataset.global === "true" });
    $("exCount").textContent = list.length ? "· " + list.length : "";
  }
  $("menuSuggest").onclick = () => send("suggest");
  $("menuTranscript").onclick = () => send("transcript");
  $("menuSettings").onclick = () => send("settings");
  $("stopBtn").onclick = () => send("stop");
  $("undoBtn").onclick = () => send("undo");
  $("resendBtn").onclick = () => send("resend");
  document.addEventListener("click", (e) => { if (!popup.contains(e.target) && e.target !== $("slash") && e.target !== input) popup.hidden = true; });

  setInterval(() => { const el = $("elapsed"); if (el) { const s = Math.round((Date.now() - Number(el.dataset.start)) / 1000); el.textContent = "· " + (s >= 60 ? Math.floor(s / 60) + " min " + (s % 60) + " s" : s + " s"); } }, 1000);
  window.addEventListener("message", (e) => {
    if (e.data.type === "state") {
      // seznam souborů chodí jen při změně; jinak zůstává minulý
      if (e.data.state.files === undefined) e.data.state.files = state.files || [];
      state = e.data.state; render();
    } else if (e.data.type === "ack") finish(e.data.reqId, e.data.error);
  });
  send("ready");
</script>
</body></html>`;
  }
}
