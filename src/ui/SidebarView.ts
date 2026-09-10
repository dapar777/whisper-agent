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
    view.webview.onDidReceiveMessage((m) =>
      this.onMessage(m).catch((e: Error) => void vscode.window.showErrorMessage(`Whisper: ${e.message}`)),
    );
    view.onDidChangeVisibility(() => void this.push());
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
    }
  }

  private async push(): Promise<void> {
    if (!this.view) return;
    const c = this.controller;
    const hunks = await c.review.pendingHunks();
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
          }
        : undefined,
      items: c.items.slice(-150),
      current: c.currentAction,
      promptPhase: c.promptPhase,
      approvals: { mode: c.approvals.mode, pending: c.approvals.pendingRequests, history: c.approvals.history.slice(-8), patterns: c.approvals.allowPatterns() },
      review: c.review.pendingFiles.map((f) => ({ path: f.path, kind: f.kind, hunks: hunks.filter((h) => h.path === f.path).length })),
      commands: c.commands().map((x) => ({ name: x.name, kind: x.kind, description: x.description })),
      log: c.log.slice(-80),
    };
    void this.view.webview.postMessage({ type: "state", state });
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
  .topbar { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  .logo { display: flex; align-items: center; gap: 6px; font-weight: 600; letter-spacing: .2px; }
  .logo .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); }
  .spacer { flex: 1; }
  .pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
  .pill.on { border-color: var(--accent); color: var(--accent); }

  /* stavový banner */
  .banner { margin: 10px 10px 0; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--card); display: flex; flex-direction: column; gap: 6px; }
  .banner .title { display: flex; align-items: center; gap: 8px; font-weight: 600; }
  .banner .sub { color: var(--muted); font-size: 12px; }
  .banner .btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
  .banner.waiting { border-color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, var(--card)); }
  .banner.executing { border-color: var(--info); }
  .banner.asking { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--card)); }
  .banner.done { border-color: var(--ok); }
  .beacon { width: 10px; height: 10px; border-radius: 50%; background: var(--warn); animation: pulse 1.2s ease-in-out infinite; }
  .banner.executing .beacon { background: var(--info); animation-duration: .6s; }
  .banner.asking .beacon { background: var(--accent); }
  .banner.done .beacon { background: var(--ok); animation: none; }
  @keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 0%, transparent); opacity: 1 } 50% { opacity: .35 } }

  /* chat */
  #chat { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
  .msg { max-width: 100%; border-radius: 10px; padding: 8px 10px; border: 1px solid var(--border); background: var(--card); font-size: 12.5px; line-height: 1.45; }
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
  .line { color: var(--muted); font-size: 11px; display: flex; align-items: center; gap: 6px; padding: 0 4px; }
  .line .btns { margin-left: auto; display: flex; gap: 4px; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
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
  .btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; align-items: center; }
  .badge { font-size: 10px; text-transform: uppercase; letter-spacing: .4px; padding: 1px 6px; border-radius: 4px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }

  /* review */
  .review { margin: 0 10px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); font-size: 12px; }
  .review .row { display: flex; gap: 6px; align-items: center; padding: 2px 0; }
  .review .path { flex: 1; font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .sugItem { border-top: 1px solid var(--border); padding: 4px 0; }
  .sugItem summary { display: flex; align-items: center; gap: 6px; cursor: pointer; list-style: none; }
  .sugItem summary::-webkit-details-marker { display: none; }
  .sugItem summary::before { content: "▸"; color: var(--muted); font-size: 10px; }
  .sugItem[open] summary::before { content: "▾"; }
  .sugItem pre { margin-top: 4px; max-height: 160px; }

  /* composer */
  .composer { padding: 8px 10px 10px; border-top: 1px solid var(--border); position: relative; }
  .composer .box { display: flex; gap: 6px; align-items: flex-end; }
  .composer.asking { background: color-mix(in srgb, var(--accent) 10%, var(--bg)); border-top: 2px solid var(--accent); }
  .composer.asking textarea { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent); }
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
    <div class="logo"><span class="dot"></span> Whisper</div>
    <span id="turnPill" class="pill" hidden></span>
    <span id="planPill" class="pill" hidden>PLAN</span>
    <div class="spacer"></div>
    <button id="modeBtn" class="pill" title="Schvalování příkazů mimo allowlist">ptát se</button>
    <button id="menuSuggest" class="ghost small" title="Navrhnout skilly, hooky a úkoly z průběhu">💡</button>
    <button id="menuTranscript" class="ghost small" title="Otevřít záznam průběhu (.whisper/transcript.jsonl)">🗒</button>
    <button id="menuSettings" class="ghost small" title="Otevřít nastavení Whisperu">⚙</button>
  </div>

  <div id="exceptions" class="banner" hidden>
    <div class="title">Schvalování příkazů</div>
    <div class="btns"><button id="modeAsk" class="small">ptát se</button><button id="modeAuto" class="small">auto (bez dotazů)</button><span class="sub">denylist platí vždy</span></div>
    <div class="sub">Výjimky: regulární výrazy na celý příkaz, které se spouštějí bez dotazu</div>
    <div id="patterns"></div>
    <div class="btns"><input id="newPattern" type="text" placeholder="^npm (test|run lint)\\b"><button id="addPatternWs" class="small">Přidat (projekt)</button><button id="addPatternGlobal" class="small">Přidat (globálně)</button></div>
  </div>

  <div id="banner" class="banner" hidden>
    <div class="title"><span class="beacon"></span><span id="bannerTitle"></span></div>
    <div id="bannerSub" class="sub"></div>
    <div id="bannerBtns" class="btns"></div>
  </div>

  <div id="chat"></div>

  <div id="review" class="review" hidden></div>

  <div id="suggestions" class="review" hidden>
    <div class="row"><b>Návrhy ke schválení (<span id="sugCount"></span>)</b><span class="spacer"></span><button id="sugToggle" class="ghost small">▾</button><button class="small primary" id="sugAcceptAll">Přijmout vše</button><button class="small" id="sugRejectAll">Zamítnout vše</button></div>
    <div id="sugList"></div>
  </div>

  <div id="composer" class="composer">
    <div id="popup" class="popup" hidden></div>
    <div id="askHint" class="askhint" hidden><b>❓ Odpověď pro model:</b><span id="askText" class="q"></span></div>
    <div id="askOptions" class="btns" hidden></div>
    <div class="box">
      <button id="slash" class="slashbtn" title="Příkazy a skilly">/</button>
      <textarea id="input" rows="2" placeholder="Zadejte úkol… (/ pro příkazy, Enter odešle, Shift+Enter nový řádek)"></textarea>
      <button id="send" class="primary" title="Odeslat (Enter)">➤</button>
    </div>
    <div class="hint"><span id="hint"></span><span class="spacer"></span><button id="stopBtn" class="ghost small" hidden>■ zrušit</button><button id="undoBtn" class="ghost small" hidden>↶ undo</button><button id="resendBtn" class="ghost small" hidden title="Znovu poslat celý kontext (pro nový chat)">↻ celý kontext znovu</button></div>
  </div>

  <details class="log"><summary>Log</summary><pre id="log"></pre></details>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const send = (type, extra) => vscode.postMessage({ type, ...(extra || {}) });
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const kb = (n) => (n / 1000).toFixed(1) + " k";
  let state = { items: [], commands: [], approvals: { mode: "ask", pending: [], history: [] }, review: [], log: [] };
  let lastCount = -1;
  let wasAsking = false;

  // ---------- jednoduchý markdown ----------
  function md(text) {
    const lines = String(text ?? "").split("\\n");
    let html = ""; let inList = false; let inPre = false; let pre = [];
    const inline = (s) => esc(s).replace(/\`([^\`]+)\`/g, "<code>$1</code>").replace(/\\*\\*([^*]+)\\*\\*/g, "<b>$1</b>");
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
      items.push('<li class="l' + level + (done ? " done" : "") + '"><span class="box">' + (done ? "☑" : "☐") + "</span><span>" + esc(m[3]) + "</span></li>");
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
    $("turnPill").hidden = !active; if (active) $("turnPill").textContent = "kolo " + s.turn;
    $("planPill").hidden = !(active && s.planMode);
    $("modeBtn").textContent = (state.approvals.mode === "auto" ? "auto" : "ptát se") + " · výjimky " + ((state.approvals.patterns || []).length);
    $("modeBtn").className = "pill" + (state.approvals.mode === "auto" ? " on" : "");
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
      $("bannerSub").textContent = s.state === "waitingForReply"
        ? (sent ? "Prompt byl vložen. Až model odpoví, zkopírujte odpověď (Ctrl+C), Whisper ji sám převezme." : "Vložte prompt do chatu (Ctrl+V); Whisper pozná, že byl vložen.") + " (" + kb(s.promptChars) + " znaků)"
        : sub;
      const b = $("bannerBtns"); b.innerHTML = "";
      if (s.state === "waitingForReply") {
        b.innerHTML = '<button class="primary small" data-act="copyAgain">📋 Zkopírovat prompt znovu</button><button class="small" data-act="showPrompt">Zobrazit prompt</button><button class="small" data-act="pasteClip">Vzít odpověď ze schránky</button><button class="small" data-act="resend" title="Pro nový chat: preambule + shrnutí dosavadního průběhu">↻ Poslat celý kontext znovu</button><button class="ghost small" data-act="correction" title="Když model odpověděl bez bloku akcí a nebyla to otázka">Poslat opravný prompt</button>';
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
    chat.innerHTML = parts.join("");
    for (const x of chat.querySelectorAll("[data-act]")) x.onclick = onAct;
    if (stick || state.items.length !== lastCount) chat.scrollTop = chat.scrollHeight;
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
    $("log").textContent = state.log.join("\\n");
  }

  function renderItem(it, s) {
    const turn = it.turn ? '<span class="badge">kolo ' + it.turn + "</span>" : "";
    switch (it.kind) {
      case "task": return '<div class="msg user"><div class="head"><b>Vy</b>' + (it.data && it.data.planMode ? '<span class="badge">plan</span>' : "") + '</div>' + md(it.text) + "</div>";
      case "note": return '<div class="msg user"><div class="head"><b>Vy</b><span>poznámka k dalšímu promptu</span></div>' + md(it.text) + "</div>";
      case "answer": return '<div class="msg user"><div class="head"><b>Vy</b><span>odpověď</span></div>' + md(it.text) + "</div>";
      case "dialog": {
        const d = it.data || {};
        if (d.from === "user") return '<div class="msg user"><div class="head"><b>Vy</b><span>napsáno přímo v chatu</span></div>' + md(it.text) + "</div>";
        return '<div class="msg ask"><div class="head"><b>Model' + (d.live ? " se ptá v chatu" : " se ptal v chatu") + "</b>" + turn + "</div>" + md(it.text) + (d.live ? '<div class="sub">Odpovězte přímo v chatu a zkopírujte jeho další odpověď.</div>' : "") + "</div>";
      }
      case "prompt": {
        const att = it.data && it.data.attachments && it.data.attachments.length ? " · 📎 " + it.data.attachments.map((a) => esc(String(a).split("/").pop())).join(", ") : "";
        return '<div class="line">📋 kolo ' + it.turn + " · prompt ve schránce (" + kb(it.data ? it.data.chars : 0) + (it.data && it.data.mode === "file" ? ", soubory" : "") + ")" + att + '<span class="btns"><button class="ghost small" data-act="copyAgain">znovu</button><button class="ghost small" data-act="showPrompt">zobrazit</button></span></div>';
      }
      case "status": return '<div class="msg model"><div class="head"><b>Model</b>' + turn + "</div>" + md(it.text) + "</div>";
      case "actions": return '<div class="msg tools"><div class="head"><b>Akce</b>' + turn + '</div><div class="chips">' + (it.data || []).map((a) => '<span class="chip">' + esc(a.tool) + (a.target ? " " + esc(a.target) : "") + "</span>").join("") + "</div></div>";
      case "results": return '<div class="msg tools"><div class="head"><b>Výsledky</b>' + turn + '</div><div class="chips">' + (it.data || []).map((r) => '<span class="chip ' + (r.status === "ok" ? "ok" : "err") + '">' + (r.status === "ok" ? "✓" : "✗") + " " + esc(r.tool) + (r.target ? " " + esc(String(r.target).slice(0, 60)) : "") + (r.meta && r.meta.exit !== undefined ? " exit " + esc(r.meta.exit) : "") + (r.meta && r.meta.hunks ? " " + esc(r.meta.hunks) : "") + "</span>").join("") + "</div></div>";
      case "plan": return '<div class="msg plan"><div class="head"><b>Plán</b>' + turn + "</div>" + checklist(it.text) + "</div>";
      case "ask": {
        const o = (it.data && it.data.options) || [];
        const live = s && s.state === "awaitingUser" && s.pendingQuestion === it.text;
        const opts = o.length && live ? '<div class="btns">' + o.map((x) => '<button class="small" data-act="pick" data-opt="' + esc(x) + '">' + esc(x) + "</button>").join("") + (it.data.multi ? '<span class="badge">více možností: vyberte dole</span>' : "") + "</div>" : "";
        return '<div class="msg ask"><div class="head"><b>Model se ptá</b></div>' + md(it.text) + opts + "</div>";
      }
      case "done": return '<div class="msg done"><div class="head"><b>Hotovo</b></div>' + md(it.text) + "</div>";
      case "error": return '<div class="msg error"><div class="head"><b>Chyba</b>' + turn + "</div>" + esc(it.text) + "</div>";
      case "undo": return '<div class="line">↶ ' + esc(it.text) + "</div>";
      case "suggestion": {
        const d = it.data || {};
        const live = s && s.suggestions ? s.suggestions.find((x) => x.id === d.id) : null;
        const decision = (live && live.decision) || d.decision;
        const dup = (live && live.duplicate) || d.duplicate;
        return '<div class="line">💡 návrh <span class="badge">' + esc(d.kind) + "</span> " + (d.update ? '<span class="badge" title="úprava existující položky">upravuje ' + esc(d.update) + "</span> " : "") + esc(d.title) +
          (dup ? ' <span class="badge" title="stejná věc už existuje, návrh se přeskočil">duplikát</span>' : decision ? ' <span class="badge">' + (decision === "approved" ? "přijato" : "zamítnuto") + "</span>" : " · čeká v sekci Návrhy") + "</div>";
      }
      default: return "";
    }
  }

  function renderApproval(a) {
    const isCmd = a.kind === "command";
    const suggested = isCmd ? "^" + esc(a.text.split(/\\s+/).slice(0, 2).map((w) => w.replace(/[.*+?^$(){}|[\\]\\\\]/g, "\\\\$&")).join("\\\\s+")) + "\\\\b" : "";
    return '<div class="msg approval" data-approval="' + esc(a.id) + '"><div class="head"><b>' + (isCmd ? "Spustit příkaz?" : "Smazat soubor?") + "</b>" + (a.cwd && a.cwd !== "." ? '<span>v ' + esc(a.cwd) + "</span>" : "") + '</div><span class="cmd">' + esc(a.text) + "</span>" +
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
  const input = $("input"); const popup = $("popup"); let sel = 0; let popupItems = [];
  function currentSlash() {
    const v = input.value; const pos = input.selectionStart;
    const before = v.slice(0, pos);
    const m = before.match(/(^|\\s)\\/([\\w.-]*)$/);
    return m ? { prefix: m[2], start: pos - m[2].length - 1 } : null;
  }
  function showPopup(prefix, forceAll) {
    const p = (prefix || "").toLowerCase();
    popupItems = state.commands.filter((c) => forceAll || c.name.toLowerCase().startsWith(p)).sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "builtin" ? -1 : 1).slice(0, 14);
    if (!popupItems.length) { popup.hidden = true; return; }
    sel = Math.min(sel, popupItems.length - 1);
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
  input.addEventListener("input", () => { const cs = currentSlash(); if (cs) { sel = 0; showPopup(cs.prefix); } else popup.hidden = true; });
  input.addEventListener("keydown", (e) => {
    if (!popup.hidden) {
      if (e.key === "ArrowDown") { sel = (sel + 1) % popupItems.length; showPopup(currentSlash()?.prefix, !currentSlash()); e.preventDefault(); return; }
      if (e.key === "ArrowUp") { sel = (sel - 1 + popupItems.length) % popupItems.length; showPopup(currentSlash()?.prefix, !currentSlash()); e.preventDefault(); return; }
      if (e.key === "Tab" || e.key === "Enter") { accept(sel); e.preventDefault(); return; }
      if (e.key === "Escape") { popup.hidden = true; e.preventDefault(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  function submit() { const t = input.value.trim(); if (!t) return; send("send", { text: t }); input.value = ""; popup.hidden = true; }
  $("send").onclick = submit;
  $("slash").onclick = () => { if (!popup.hidden) { popup.hidden = true; return; } sel = 0; showPopup("", true); input.focus(); };
  $("modeBtn").onclick = () => { $("exceptions").hidden = !$("exceptions").hidden; };
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
        '<details class="sugItem"><summary><span class="badge">' + esc(x.kind) + "</span> " + (x.update ? '<span class="badge" title="úprava existující položky">upravuje ' + esc(x.update) + "</span> " : "") + esc(x.title) +
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
  }
  $("menuSuggest").onclick = () => send("suggest");
  $("menuTranscript").onclick = () => send("transcript");
  $("menuSettings").onclick = () => send("settings");
  $("stopBtn").onclick = () => send("stop");
  $("undoBtn").onclick = () => send("undo");
  $("resendBtn").onclick = () => send("resend");
  document.addEventListener("click", (e) => { if (!popup.contains(e.target) && e.target !== $("slash") && e.target !== input) popup.hidden = true; });

  setInterval(() => { const el = $("elapsed"); if (el) { const s = Math.round((Date.now() - Number(el.dataset.start)) / 1000); el.textContent = "· " + (s >= 60 ? Math.floor(s / 60) + " min " + (s % 60) + " s" : s + " s"); } }, 1000);
  window.addEventListener("message", (e) => { if (e.data.type === "state") { state = e.data.state; render(); } });
  send("ready");
</script>
</body></html>`;
  }
}
