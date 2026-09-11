import * as fs from "fs";
import * as os from "os";
import * as vscode from "vscode";
import { ClipboardBridge, decoratePrompt } from "../clipboard/ClipboardBridge";
import {
  addGlobalHook,
  appendAgentFeedback,
  appendGlobalInstructions,
  appendGlobalRule,
  readGlobalHooks,
  readGlobalInstructions,
  readGlobalRules,
  replaceGlobalHook,
  replaceGlobalRule,
} from "../global/GlobalConfig";
import { addHook, loadHooks } from "../hooks/Hooks";
import { VsCodeHost } from "../host/VsCodeHost";
import { BundleUsage, buildCorrectionPrompt, ProjectContext } from "../protocol/PromptBuilder";
import { isOwnPrompt, looksLikeReply } from "../protocol/replyDetect";
import { BUILTIN_COMMANDS, composeTask, parseInput, SlashCommand } from "../protocol/slash";
import { ReviewManager } from "../review/ReviewManager";
import { Checkpoint } from "../safety/Checkpoint";
import { Session } from "../session/Session";
import { Suggestion } from "../session/SessionData";
import { loadSkills, saveSkill } from "../skills/Skills";
import { renderRefs, resolveRefs } from "../tools/refs";
import { parseRefs } from "../protocol/refs";
import { saveScript } from "../skills/Scripts";
import { PLAN_FILE } from "../tools/ToolRunner";
import { ChangeListener } from "../tools/ToolRunner";
import { describeActions, describeResults, Transcript, TranscriptEvent } from "../transcript/Transcript";
import { cfg, toRel, workspaceRoot } from "../util";
import { ApprovalService } from "./Approvals";
import { RULES_FILE, TurnEngine } from "./TurnEngine";

const HELP = [
  "Napište zadání a odešlete (Enter). Prompt se zkopíruje do schránky; vložte ho do chatu s modelem,",
  "zkopírujte odpověď a Whisper ji sám převezme.",
  "",
  "Příkazy: /plan zadání (režim PLAN s checklistem), /suggest (návrhy skillů, hooků, povolení a úkolů z průběhu),",
  "/auto (přepnout schvalování příkazů), /resend (nový chat), /undo (vrátit kolo), /stop (zrušit), /new (vyčistit),",
  "/status, /skills, /název-skillu zadání.",
  "",
  "Vestavěné skilly: /init (založí WHISPER.md z průzkumu projektu), /commit, /review, /test, /fix <chyba>,",
  "/explain <co>, /docs, /deps. Vlastní skilly: .whisper/skills/ (projekt) nebo ~/.whisper/skills/ (uživatel).",
  "",
  "Během čekání na odpověď můžete psát poznámky; přiloží se k dalšímu promptu. Když se model zeptá, odpověď napište sem.",
  "",
  "Nastavení: tlačítko ⚙ v horní liště panelu, nebo Ctrl+, a do hledání napsat „whisper“.",
  "Instrukce pro projekt patří do WHISPER.md v kořeni, pravidla do .whisper/rules.md, skilly do .whisper/skills/.",
].join("\n");

export class Controller implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly output = vscode.window.createOutputChannel("Whisper Agent");
  private cts: vscode.CancellationTokenSource | undefined;
  private pendingNotes: string[] = [];
  private engine: TurnEngine | undefined;
  private host: VsCodeHost | undefined;
  private transcript: Transcript | undefined;
  /** položky chatu aktuálního sezení (pro UI) */
  items: TranscriptEvent[] = [];
  skills: SlashCommand[] = [];
  log: string[] = [];
  /** právě vykonávaná akce (pro banner s časem) */
  currentAction: { tool: string; target: string; startedAt: number; index: number; total: number } | undefined;
  private execAbort: AbortController | undefined;

  /** Ručně pošle opravný prompt (když odpověď bez bloku nebyla otázka, ale chyba protokolu). */
  async sendCorrection(): Promise<void> {
    const s = this.session.current;
    if (!s || s.state !== "waitingForReply") return;
    this.cancelWait();
    this.pushItem({ kind: "status", text: "Posílám opravný prompt." });
    void this.loop(buildCorrectionPrompt(s.id, s.turn, ["The previous reply contained no <whisper> block with actions."]));
  }

  /** Přeruší běžící provádění akcí; modelu se pošlou dosavadní výsledky s vysvětlením. */
  interrupt(): void {
    if (!this.execAbort) {
      vscode.window.setStatusBarMessage("Whisper: teď se nic neprovádí.", 3000);
      return;
    }
    this.execAbort.abort();
    this.pushItem({ kind: "status", text: "Provádění přerušeno uživatelem; výsledky a vysvětlení jdou modelu." });
  }

  constructor(
    readonly session: Session,
    readonly review: ReviewManager,
    readonly clipboard: ClipboardBridge,
    private readonly checkpoint: Checkpoint,
    readonly approvals: ApprovalService,
  ) {
    approvals.onDidChange(() => this.changeEmitter.fire());
    // fáze promptu: "fresh" = ve schránce, ještě nevložen; "sent" = skutečně vložen (schránku si vyžádala jiná
    // aplikace) nebo uživatel zkopíroval něco jiného
    clipboard.onDidPaste(() => {
      if (this.promptPhase === "fresh") this.setPromptPhase("sent");
    });
    clipboard.onDidCopyOther(() => {
      if (this.promptPhase === "fresh") this.setPromptPhase("sent");
    });
    clipboard.onDidLog((l) => this.logLine(l));
    this.reloadSkills();
  }

  /** "fresh" = prompt ve schránce, ještě nevložen do chatu; "sent" = zřejmě vložen, čeká se na model. */
  promptPhase: "fresh" | "sent" | undefined;

  private setPromptPhase(phase: "fresh" | "sent" | undefined): void {
    if (this.promptPhase === phase) return;
    this.promptPhase = phase;
    this.changeEmitter.fire();
  }

  // ---------- veřejné API pro UI ----------

  commands(): SlashCommand[] {
    return [...BUILTIN_COMMANDS, ...this.skills];
  }

  /** složka vestavěných skillů (skills/ v rozšíření); nastavuje extension.ts */
  builtinSkillsDir?: string;

  reloadSkills(): void {
    try {
      this.skills = loadSkills(workspaceRoot().fsPath, this.builtinSkillsDir);
    } catch {
      this.skills = [];
    }
    this.changeEmitter.fire();
  }

  /** Jediný vstup z chatu: zadání, odpověď na otázku, poznámka, ruční vložení odpovědi, /příkazy. */
  async submit(input: string): Promise<void> {
    const raw = input.trim();
    if (!raw) return;
    const s = this.session.current;
    // ručně vložená odpověď modelu
    if (s && s.state === "waitingForReply" && looksLikeReply(raw, this.clipboard.currentPrompt)) {
      this.submitReply(raw);
      return;
    }
    const parsed = parseInput(raw, this.commands());
    for (const u of parsed.unknown) this.pushItem({ kind: "error", text: `Neznámý příkaz /${u}` });
    for (const c of parsed.commands) {
      switch (c) {
        case "stop":
          this.abort();
          return;
        case "undo":
          await this.undoTurn();
          return;
        case "resend":
          await this.resendContext();
          return;
        case "auto":
          await this.approvals.setMode(this.approvals.mode === "auto" ? "ask" : "auto");
          this.pushItem({ kind: "status", text: `Schvalování příkazů: ${this.approvals.mode === "auto" ? "automaticky" : "ptát se"}` });
          return;
        case "help":
          this.pushItem({ kind: "status", text: HELP });
          return;
        case "new":
          if (s && !["idle", "done"].includes(s.state)) this.abort();
          this.items = [];
          this.pushItem({ kind: "status", text: "Panel vyčištěn. Napište nové zadání." });
          return;
        case "status":
          this.pushItem({ kind: "status", text: this.describeStatus() });
          return;
        case "skills":
          this.pushItem({
            kind: "status",
            text: this.skills.length
              ? "Skilly:\n" + this.skills.map((k) => `/${k.name} – ${k.description}${k.builtin ? " [vestavěný]" : k.source?.startsWith(os.homedir()) ? " [uživatel]" : " [projekt]"}`).join("\n")
              : "Žádné skilly.",
          });
          return;
        case "suggest":
          await this.runSuggest();
          return;
      }
    }
    const planMode = parsed.commands.includes("plan");
    if (s && s.state === "awaitingUser" && parsed.text) {
      await this.answerQuestion(parsed.text);
      return;
    }
    if (s && (s.state === "waitingForReply" || s.state === "executing") && parsed.text) {
      // #odkazy v poznámce se vyřeší hned, ať je obsah v příštím promptu
      const noteText = parsed.text + (await this.refsBlock(parsed.text));
      s.notes = [...(s.notes ?? []), noteText];
      this.session.update({ notes: s.notes });
      this.pushItem({ kind: "note", text: parsed.text, data: { refs: parseRefs(parsed.text).map((r) => r.raw) } });
      await this.transcript?.append({ session: s.id, kind: "note", text: parsed.text });
      return;
    }
    if (!parsed.text && parsed.skills.length === 0) {
      if (planMode) this.pushItem({ kind: "status", text: "Napište za /plan i zadání úkolu." });
      return;
    }
    await this.start(composeTask(parsed), planMode, raw);
  }

  private describeStatus(): string {
    const s = this.session.current;
    if (!s) return "Žádné sezení. Napište zadání.";
    const states: Record<string, string> = {
      idle: "nečinný",
      waitingForReply: this.promptPhase === "sent" ? "čekám na odpověď modelu (prompt vložen)" : "prompt je ve schránce, ještě nebyl vložen",
      executing: `provádím akce${this.currentAction ? ` (${this.currentAction.tool})` : ""}`,
      awaitingUser: "čekám na vaši odpověď",
      done: "hotovo",
    };
    const lines = [
      `Sezení ${s.id}: ${states[s.state] ?? s.state}, kolo ${s.turn}, režim ${s.mode}${s.planMode ? " + PLAN" : ""}.`,
      `Schvalování příkazů: ${this.approvals.mode === "auto" ? "automaticky" : "ptát se"}; výjimek: ${this.approvals.allowPatterns().length}.`,
    ];
    if (s.plan) {
      const items = s.plan.split("\n").filter((l) => /^\s*- \[[ xX]\]/.test(l));
      lines.push(`Plán: ${items.filter((l) => /\[[xX]\]/.test(l)).length}/${items.length} hotovo.`);
    }
    if (s.pendingQuestion) lines.push(`Otázka: ${s.pendingQuestion}`);
    return lines.join("\n");
  }

  async start(task: string, planMode = false, original?: string): Promise<void> {
    if (this.session.current && !["idle", "done"].includes(this.session.current.state)) {
      const pick = await vscode.window.showWarningMessage("Běží jiný úkol. Zrušit ho a začít nový?", { modal: true }, "Zrušit a začít");
      if (pick !== "Zrušit a začít") return;
      this.abort();
    }
    workspaceRoot();
    const mode = cfg<"stateful" | "stateless">("mode", "stateful");
    const previous = this.session.current?.id;
    const s = this.session.start(task, mode);
    s.planMode = planMode;
    this.items = [];
    this.pushItem({ kind: "task", text: original ?? task, data: { planMode } });
    this.logLine(`▶ Nový úkol (${mode}${planMode ? ", PLAN" : ""}): ${task.split("\n")[0]}`);
    const engine = this.newEngine();
    await engine.archivePlan(previous);
    await this.transcript?.append({ session: s.id, kind: "task", text: task, data: { planMode } });
    const ctx = await engine.gatherContext(this.activeEditor(), this.skills.map((k) => ({ name: k.name, description: k.description })));
    ctx.refs = renderRefs(await resolveRefs(engine.hostRef(), original ?? task, this.activeEditor()));
    const prompt = await engine.initialPrompt(s, ctx);
    void this.loop(prompt);
  }

  /** /suggest: požádá model o návrhy skillů, hooků, povolení a úkolů z celého průběhu v .whisper. */
  async runSuggest(): Promise<void> {
    workspaceRoot();
    const engine = this.engine ?? this.newEngine();
    const events = (await this.transcript?.readAll()) ?? [];
    if (events.length === 0) {
      this.pushItem({ kind: "status", text: "Zatím není žádný průběh k analýze (.whisper/transcript.jsonl je prázdný)." });
      return;
    }
    let s = this.session.current;
    if (!s || ["done", "idle"].includes(s.state)) {
      s = this.session.start("/suggest", cfg<"stateful" | "stateless">("mode", "stateful"));
      this.items = [];
    } else if (s.state !== "awaitingUser") {
      this.pushItem({ kind: "status", text: "Návrhy jde spustit až po dokončení běžícího úkolu (nebo použijte /stop)." });
      return;
    }
    this.pushItem({ kind: "task", text: "/suggest – návrhy z průběhu práce" });
    const summary = Transcript.summarize(events);
    const ctx = await engine.gatherContext(undefined, this.skills.map((k) => ({ name: k.name, description: k.description })));
    ctx.existing = { ...ctx.existing, skillBodies: this.skills.slice(0, 12).map((k) => ({ name: k.name, body: k.body ?? "" })) };
    const prompt = engine.suggestPrompt(s, summary, ctx, Transcript.suggestionHistory(events));
    this.logLine("💡 Žádám model o návrhy z průběhu.");
    void this.loop(prompt);
  }

  async decideSuggestion(id: string, approve: boolean): Promise<void> {
    const s = this.session.current;
    const sug = s?.suggestions?.find((x) => x.id === id);
    if (!s || !sug || sug.decision) return;
    sug.decision = approve ? "approved" : "rejected";
    if (approve) {
      try {
        await this.applySuggestion(sug);
        this.pushItem({ kind: "status", text: `Návrh „${sug.title}“ použit (${sug.kind}).` });
      } catch (e) {
        sug.decision = undefined;
        this.pushItem({ kind: "error", text: `Návrh se nepodařilo použít: ${(e as Error).message}` });
      }
    }
    await this.transcript?.append({ session: s.id, kind: "suggestion", text: `${sug.kind}: ${sug.title} → ${sug.decision}` });
    this.session.update({ suggestions: s.suggestions });
  }

  /** Návrh je duplikát něčeho, co už existuje (bez update= nedává smysl ho nabízet). */
  private async isDuplicateSuggestion(sug: Suggestion): Promise<boolean> {
    if (sug.update) return false;
    const host = this.host ?? this.newEngine().hostRef();
    const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    const body = norm(sug.body);
    try {
      switch (sug.kind) {
        case "skill":
          return this.skills.some((k) => k.name === norm(sug.title).replace(/[^a-z0-9._-]+/g, "-") || (k.body && norm(k.body) === body));
        case "rule": {
          const rules = [...readGlobalRules()];
          if (await host.exists(RULES_FILE)) rules.push(...(await host.readFile(RULES_FILE)).split(/\r?\n/).map((l) => l.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean));
          return rules.some((r) => norm(r) === body);
        }
        case "whisper": {
          const texts = [readGlobalInstructions(), (await host.exists("WHISPER.md")) ? await host.readFile("WHISPER.md") : ""].map(norm);
          return body.length > 0 && texts.some((t) => t.includes(body));
        }
        case "hook": {
          const h = JSON.parse(sug.body) as { match?: string; run?: string };
          const hooks = [...readGlobalHooks(), ...(await loadHooks(host))];
          return hooks.some((x) => x.match === h.match && x.run === h.run);
        }
        case "allow":
          return (host.policy.allowPatterns ?? []).includes(sug.body.trim()) || host.policy.autoAllow.some((a) => norm(a) === body);
        case "task": {
          const plan = (await host.exists(PLAN_FILE)) ? norm(await host.readFile(PLAN_FILE)) : "";
          return plan.includes(norm(sug.title));
        }
        default:
          return false;
      }
    } catch {
      return false;
    }
  }

  /** Přijme nebo zamítne všechny čekající návrhy (v pořadí, každý zvlášť, chyby nezastaví ostatní). */
  async decideAllSuggestions(approve: boolean): Promise<void> {
    const pending = (this.session.current?.suggestions ?? []).filter((x) => !x.decision);
    for (const sug of pending) await this.decideSuggestion(sug.id, approve);
  }

  private async applySuggestion(sug: Suggestion): Promise<void> {
    const host = this.host ?? this.newEngine().hostRef();
    const global = sug.scope === "global";
    // model občas převezme HTML entity z našich výsledků (&amp;&amp;); do textových položek patří skutečné znaky
    if (["rule", "whisper", "skill", "script", "agent", "task"].includes(sug.kind)) sug.body = decodeEntities(sug.body);
    switch (sug.kind) {
      case "skill": {
        if (sug.update) {
          // úprava existujícího skillu: přepíše soubor tam, kde skill žije
          const existing = this.skills.find((k) => k.name === sug.update!.toLowerCase().replace(/^\//, ""));
          if (!existing?.source) throw new Error(`skill /${sug.update} neexistuje`);
          fs.writeFileSync(existing.source, sug.body.trim() + "\n", "utf8");
        } else {
          saveSkill(workspaceRoot().fsPath, sug.title, sug.body, global);
        }
        this.reloadSkills();
        return;
      }
      case "script": {
        // spustitelný skript: uloží se do .whisper/scripts (nebo ~/.whisper/scripts) a zapíše se do logu, jak ho spustit
        const saved = saveScript(workspaceRoot().fsPath, sug.title, sug.body, { global, lang: sug.lang, file: sug.file });
        this.logLine(`📜 Skript uložen: ${saved.rel} (spustit: ${saved.command})`);
        this.pushItem({ kind: "status", text: `Skript uložen do ${saved.rel}. Spustíte ho příkazem: ${saved.command}` });
        return;
      }
      case "whisper":
        if (global) appendGlobalInstructions(sug.body);
        else await host.appendFile("WHISPER.md", `\n${sug.body.trim()}\n`);
        return;
      case "rule": {
        const rule = sug.body.replace(/\s+/g, " ").trim() || sug.title;
        if (sug.update) {
          // "rule N" = pořadí v sekci Additional rules (globální pravidla první, pak projektová)
          const n = Number((sug.update.match(/(\d+)/) ?? [])[1]);
          const globalRules = readGlobalRules();
          if (!n) throw new Error(`neplatný cíl úpravy "${sug.update}", čekáno "rule N"`);
          if (n <= globalRules.length) {
            replaceGlobalRule(n - 1, rule);
          } else {
            const lines = (await host.exists(RULES_FILE)) ? (await host.readFile(RULES_FILE)).split(/\r?\n/) : [];
            const idx = lines.map((l, i) => (l.replace(/^\s*[-*]\s+/, "").trim() && !l.trim().startsWith("#") ? i : -1)).filter((i) => i >= 0)[n - globalRules.length - 1];
            if (idx === undefined) throw new Error(`pravidlo ${n} neexistuje`);
            lines[idx] = `- ${rule}`;
            await host.writeFile(RULES_FILE, lines.join("\n"));
          }
          return;
        }
        if (global) appendGlobalRule(rule);
        else await host.appendFile(RULES_FILE, `- ${rule}\n`);
        return;
      }
      case "hook": {
        const hook = JSON.parse(sug.body) as { match?: string; run?: string; cwd?: string };
        if (!hook.match || !hook.run) throw new Error('hook musí být JSON s "match" a "run"');
        const entry = { match: hook.match, run: hook.run, cwd: hook.cwd };
        if (sug.update) {
          if (replaceGlobalHook(sug.update, entry)) return;
          const project = await loadHooks(host);
          const i = project.findIndex((h) => h.match === sug.update);
          if (i < 0) throw new Error(`hook s match "${sug.update}" neexistuje`);
          const own = project.filter((h) => !readGlobalHooks().some((g) => g.match === h.match && g.run === h.run));
          const j = own.findIndex((h) => h.match === sug.update);
          if (j >= 0) own[j] = entry;
          await host.writeFile(".whisper/hooks.json", JSON.stringify({ afterChange: own }, null, 2) + "\n");
          return;
        }
        if (global) addGlobalHook(entry);
        else await addHook(host, entry);
        return;
      }
      case "allow":
        await this.approvals.addAllowPattern(sug.body.trim(), global);
        return;
      case "setting": {
        const s = JSON.parse(sug.body) as { key?: string; value?: unknown };
        if (!s.key || !s.key.startsWith("whisper.") || s.value === undefined) throw new Error('setting musí být JSON {"key": "whisper.…", "value": …}');
        await vscode.workspace
          .getConfiguration("whisper")
          .update(s.key.slice("whisper.".length), s.value, global ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace);
        return;
      }
      case "agent":
        appendAgentFeedback(sug.title, sug.body, workspaceRoot().fsPath);
        return;
      case "task": {
        const current = (await host.exists(PLAN_FILE)) ? await host.readFile(PLAN_FILE) : "";
        const line = `- [ ] ${sug.title}${sug.body.trim() ? `: ${sug.body.trim().split("\n")[0]}` : ""}`;
        const plan = current.trimEnd() + (current.trim() ? "\n" : "") + line + "\n";
        await host.writeFile(PLAN_FILE, plan);
        this.session.update({ plan });
        return;
      }
    }
  }

  async answerQuestion(answer: string): Promise<void> {
    const s = this.session.current;
    if (!s || s.state !== "awaitingUser" || !this.engine) return;
    this.pushItem({ kind: "answer", text: answer });
    await this.transcript?.append({ session: s.id, kind: "answer", text: answer });
    const prompt = this.engine.answerPrompt(s, answer + (await this.refsBlock(answer)), this.drainNotes());
    this.session.update({ pendingQuestion: undefined, pendingOptions: undefined, pendingMulti: undefined });
    void this.loop(prompt);
  }

  submitReply(text: string): void {
    if (!this.clipboard.submitManual(text)) {
      vscode.window.setStatusBarMessage("Whisper teď na žádnou odpověď nečeká.", 4000);
    }
  }

  async copyPromptAgain(): Promise<void> {
    const p = this.session.current?.pendingPrompt;
    if (!p) return void vscode.window.setStatusBarMessage("Whisper: není žádný prompt k zkopírování.", 4000);
    await this.clipboard.copyPrompt(p, this.session.current?.turn, this.session.current?.pendingAttachments ?? []);
    vscode.window.setStatusBarMessage(`$(clippy) Whisper: prompt zkopírován znovu (${kb(p)})`, 4000);
  }

  async showPrompt(): Promise<void> {
    const p = this.session.current?.pendingPrompt;
    if (!p) return;
    // s hlavičkou a patičkou, tedy přesně to, co jde do schránky
    const doc = await vscode.workspace.openTextDocument({ content: decoratePrompt(p, this.session.current?.turn), language: "markdown" });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  async showTranscript(): Promise<void> {
    const uri = vscode.Uri.joinPath(workspaceRoot(), ".whisper", "transcript.jsonl");
    await vscode.window.showTextDocument(uri, { preview: true });
  }

  async resendContext(): Promise<void> {
    const s = this.session.current;
    if (!s) return void vscode.window.showInformationMessage("Není aktivní úkol.");
    this.cancelWait();
    const engine = this.engine ?? this.newEngine();
    const ctx = await engine.gatherContext(this.activeEditor(), this.skills.map((k) => ({ name: k.name, description: k.description })));
    const prompt = await engine.resumePrompt(s, ctx);
    this.pushItem({ kind: "status", text: "Kontext znovu odeslán (nový chat)." });
    void this.loop(prompt);
  }

  async undoTurn(): Promise<void> {
    const s = this.session.current;
    const last = s?.history[s.history.length - 1];
    if (!s || !last) return void vscode.window.showInformationMessage("Není co vracet.");
    const msg = await this.checkpoint.undoLast();
    this.review.forgetTurn(last.turn);
    this.pendingNotes.push(`The user reverted ALL file changes made in turn ${last.turn}. The workspace is back to the state before that turn.`);
    this.pushItem({ kind: "undo", turn: last.turn, text: msg });
    await this.transcript?.append({ session: s.id, kind: "undo", turn: last.turn, text: msg });
  }

  abort(): void {
    const id = this.session.current?.id;
    this.cancelWait();
    this.session.clear();
    this.pushItem({ kind: "status", text: "Úkol zrušen." });
    if (id) void this.transcript?.append({ session: id, kind: "error", text: "task aborted by user" });
  }

  /** Po restartu VS Code naváže na uložené sezení. */
  async resume(): Promise<void> {
    const s = await this.session.restore();
    if (!s) return;
    const engine = this.newEngine();
    const events = (await this.transcript?.readAll()) ?? [];
    this.items = events.filter((e) => e.session === s.id && e.kind !== "prompt");
    this.logLine(`↻ Obnoveno sezení ${s.id}, kolo ${s.turn}, stav ${s.state}.`);
    await engine.initialPrompt(s, await engine.gatherContext());
    if (s.state === "waitingForReply" && s.pendingPrompt) void this.loop(s.pendingPrompt, true);
    this.changeEmitter.fire();
  }

  // ---------- smyčka ----------

  private async loop(prompt: string, skipCopy = false, attachments: string[] = []): Promise<void> {
    this.cancelWait();
    this.cts = new vscode.CancellationTokenSource();
    const token = this.cts.token;
    const engine = this.engine!;
    let noBlockStreak = 0;
    try {
      while (!token.isCancellationRequested) {
        const s = this.session.current;
        if (!s) return;
        if (skipCopy) attachments = s.pendingAttachments ?? [];
        this.session.update({ state: "waitingForReply", pendingPrompt: prompt, pendingAttachments: attachments });
        if (skipCopy) {
          this.clipboard.copyPrompt(prompt, s.turn, attachments).catch(() => undefined);
          skipCopy = false;
        } else {
          const mode = await this.clipboard.copyPrompt(prompt, s.turn, attachments);
          this.setPromptPhase("fresh");
          this.pushItem({ kind: "prompt", turn: s.turn, text: mode === "file" ? "soubor" : "text", data: { chars: prompt.length, mode, attachments } });
          await this.transcript?.append({ session: s.id, kind: "prompt", turn: s.turn, data: { chars: prompt.length } });
          this.notifyCopied(prompt, s.turn, mode);
        }

        let replyText: string;
        try {
          replyText = await this.clipboard.waitForReply(token);
        } catch {
          this.setPromptPhase(undefined);
          return; // zrušeno / nahrazeno
        }
        this.setPromptPhase(undefined);
        if (isOwnPrompt(replyText)) {
          this.logLine("⚠ Ve schránce je náš prompt, ne odpověď modelu; čekám dál.");
          skipCopy = true;
          continue;
        }
        const parsed = engine.parse(replyText);
        if (parsed.turn !== null && parsed.turn !== s.turn) {
          const pick = await vscode.window.showWarningMessage(`Odpověď vypadá jako kolo ${parsed.turn}, ale čekám kolo ${s.turn}. Použít ji přesto?`, "Použít", "Ignorovat");
          if (pick !== "Použít") {
            skipCopy = true;
            continue;
          }
        }
        await this.transcript?.append({ session: s.id, kind: "reply", turn: s.turn, text: replyText.slice(0, 20000) });
        if (parsed.prose) this.pushItem({ kind: "status", turn: s.turn, text: parsed.prose.slice(0, 600) });
        // přímý dialog: odpověď bez bloku je nejspíš otázka položená v chatu, ne chyba protokolu
        if (parsed.actions.length === 0 && cfg<boolean>("ask.direct", true) && noBlockStreak < 1) {
          noBlockStreak++;
          this.pushItem({ kind: "dialog", turn: s.turn, text: replyText.trim().slice(0, 1500), data: { from: "model", live: true } });
          this.pushItem({ kind: "status", text: "Model odpověděl bez bloku akcí, nejspíš se ptá přímo v chatu. Odpovězte mu tam a zkopírujte jeho další odpověď. Pokud jde o chybu, použijte „Poslat opravný prompt“." });
          skipCopy = true;
          continue;
        }
        noBlockStreak = parsed.actions.length ? 0 : noBlockStreak;
        if (parsed.errors.length) this.pushItem({ kind: "error", turn: s.turn, text: parsed.errors.join("\n") });
        if (parsed.actions.length) {
          this.session.update({ state: "executing" });
          this.pushItem({ kind: "actions", turn: s.turn, text: describeActions(parsed.actions), data: parsed.actions.map((a) => ({ tool: a.tool, target: a.attrs.path ?? a.attrs.pattern ?? a.attrs.title ?? (a.tool === "run" ? (a.body ?? "").trim().slice(0, 120) : "") })) });
          await this.transcript?.append({ session: s.id, kind: "actions", turn: s.turn, text: describeActions(parsed.actions) });
          await this.checkpoint.take(s.turn);
        }
        this.execAbort = new AbortController();
        const total = parsed.actions.filter((a) => !["status", "ask", "done", "dialog"].includes(a.tool)).length;
        let idx = 0;
        const step = await engine.execute(s, parsed, prompt.length, this.drainNotes(), {
          signal: this.execAbort.signal,
          onStart: (a) => {
            idx++;
            const target = a.attrs.path ?? a.attrs.pattern ?? a.attrs.title ?? (a.tool === "run" ? (a.body ?? "").trim().split("\n")[0].slice(0, 100) : "");
            this.currentAction = { tool: a.tool, target, startedAt: Date.now(), index: idx, total };
            this.changeEmitter.fire();
          },
          onEnd: () => {
            this.currentAction = undefined;
            this.changeEmitter.fire();
          },
        });
        const wasInterrupted = this.execAbort.signal.aborted;
        this.execAbort = undefined;
        this.currentAction = undefined;
        if (wasInterrupted) await this.transcript?.append({ session: s.id, kind: "error", turn: s.turn, text: "execution interrupted by user" });
        if (token.isCancellationRequested) return;
        this.session.update({});

        if (step.kind !== "correction") {
          const rec = step.record;
          for (const d of rec.dialog ?? []) {
            this.pushItem({ kind: "dialog", turn: rec.turn, text: d.text, data: { from: d.from } });
            await this.transcript?.append({ session: s.id, kind: "dialog", turn: rec.turn, text: `${d.from}: ${d.text}` });
          }
          for (const st of rec.status ? [rec.status] : []) this.pushItem({ kind: "status", turn: rec.turn, text: st });
          this.pushItem({ kind: "results", turn: rec.turn, text: describeResults(rec.results), data: rec.results.map((r) => ({ tool: r.tool, target: r.attrs.path ?? r.attrs.pattern ?? r.meta?.command ?? "", status: r.status, meta: r.meta })) });
          await this.transcript?.append({ session: s.id, kind: "results", turn: rec.turn, text: describeResults(rec.results) });
          if (s.plan && rec.actions.some((a) => a.tool === "plan")) {
            this.pushItem({ kind: "plan", turn: rec.turn, text: s.plan });
            await this.transcript?.append({ session: s.id, kind: "plan", turn: rec.turn, text: s.plan });
          }
          for (const sug of (s.suggestions ?? []).filter((x) => x.turn === rec.turn)) {
            if (await this.isDuplicateSuggestion(sug)) {
              sug.duplicate = true;
              sug.decision = "rejected";
            }
            this.pushItem({ kind: "suggestion", turn: rec.turn, text: `${sug.kind}: ${sug.title}`, data: sug });
            await this.transcript?.append({ session: s.id, kind: "suggestion", turn: rec.turn, text: `${sug.kind}: ${sug.title}${sug.duplicate ? " → duplicate" : ""}` });
          }
        }

        switch (step.kind) {
          case "correction":
            this.pushItem({ kind: "error", text: "Odpověď nešla zpracovat, posílám opravný prompt." });
            prompt = step.prompt;
            attachments = [];
            continue;
          case "done":
            this.session.update({ state: "done", finalSummary: step.summary });
            this.pushItem({ kind: "done", text: step.summary });
            await this.transcript?.append({ session: s.id, kind: "done", text: step.summary });
            await this.notifyDone();
            return;
          case "ask":
            this.session.update({ state: "awaitingUser", pendingQuestion: step.question, pendingOptions: step.options, pendingMulti: step.multi });
            this.pushItem({ kind: "ask", text: step.question, data: { options: step.options, multi: step.multi } });
            await this.transcript?.append({ session: s.id, kind: "ask", text: step.question });
            vscode.window.setStatusBarMessage(`$(question) Whisper se ptá: ${step.question.split("\n")[0].slice(0, 80)}`, 10000);
            return;
          case "next":
            prompt = step.prompt;
            attachments = step.attachments;
        }
      }
    } catch (e) {
      this.pushItem({ kind: "error", text: `Chyba: ${(e as Error).message}` });
      void vscode.window.showErrorMessage(`Whisper: ${(e as Error).message}`);
      if (this.session.current) this.session.update({ state: "waitingForReply" });
    }
  }

  // ---------- pomocné ----------

  private newEngine(): TurnEngine & { hostRef(): VsCodeHost } {
    const host = new VsCodeHost(this.output, this.approvals);
    this.host = host;
    this.transcript = new Transcript(host);
    const listener: ChangeListener = {
      onWillChange: (path, kind, baseline, turn) => {
        this.review.register(path, kind, baseline, turn);
        if (kind === "create") this.checkpoint.noteCreated(turn, path);
      },
      onWillDelete: (path, content, turn) => this.review.registerDelete(path, content, turn),
      approve: cfg<boolean>("review.requireApproval", false) ? (p, b, a) => this.approveDiff(p, b, a) : undefined,
    };
    const engine = new TurnEngine(
      host,
      {
        mode: this.session.current?.mode ?? cfg("mode", "stateful"),
        maxChars: cfg("prompt.maxChars", 60000),
        resultMaxChars: cfg("prompt.resultMaxChars", 12000),
        language: cfg("prompt.language", "cs"),
        treeMaxEntries: cfg("prompt.treeMaxEntries", 200),
        planAuto: cfg("plan.auto", true),
        continuousSuggest: cfg("suggest.continuous", false),
        directDialog: cfg("ask.direct", true),
        bundleUsage: cfg<BundleUsage>("bundle.usage", "encourage"),
      },
      listener,
    ) as TurnEngine & { hostRef(): VsCodeHost };
    engine.hostRef = () => host;
    this.engine = engine;
    return engine;
  }

  private async approveDiff(path: string, before: string, after: string): Promise<boolean> {
    const left = await vscode.workspace.openTextDocument({ content: before });
    const right = await vscode.workspace.openTextDocument({ content: after });
    await vscode.commands.executeCommand("vscode.diff", left.uri, right.uri, `${path}: navrhovaná změna`);
    const pick = await vscode.window.showInformationMessage(`Aplikovat změnu v ${path}?`, { modal: true }, "Aplikovat");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    return pick === "Aplikovat";
  }

  private activeEditor(): ProjectContext["active"] | undefined {
    const editor = vscode.window.activeTextEditor;
    const root = workspaceRoot().fsPath;
    if (!editor || editor.document.uri.scheme !== "file" || !editor.document.uri.fsPath.startsWith(root)) return undefined;
    const sel = editor.selection;
    const active: ProjectContext["active"] = { path: toRel(editor.document.uri) };
    if (!sel.isEmpty) {
      active.selection = editor.document.getText(sel).slice(0, 4000);
      active.selectionRange = `${sel.start.line + 1}-${sel.end.line + 1}`;
    }
    return active;
  }

  /** Otevře soubor z odkazu v průběhu (cesta:řádek) a odroluje na dané místo. */
  async openFileAt(rel: string, line?: number, col?: number): Promise<void> {
    if (!rel) return;
    const uri = vscode.Uri.joinPath(workspaceRoot(), rel);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      if (line && line > 0) {
        const pos = new vscode.Position(Math.min(line - 1, doc.lineCount - 1), Math.max(0, (col ?? 1) - 1));
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    } catch {
      vscode.window.setStatusBarMessage(`Whisper: soubor ${rel} nelze otevřít.`, 4000);
    }
  }

  /** Přílohy čekajícího promptu (název + velikost), aby je bylo v panelu vidět. */
  attachmentInfo(): { name: string; path: string; chars: number }[] {
    const rels = this.session.current?.pendingAttachments ?? [];
    return rels.map((rel) => {
      let chars = 0;
      try {
        chars = fs.statSync(vscode.Uri.joinPath(workspaceRoot(), rel).fsPath).size;
      } catch {
        /* soubor mohl zmizet; velikost je jen doplňková informace */
      }
      return { name: rel.split("/").pop() ?? rel, path: rel, chars };
    });
  }

  /** Cesty souborů pro doplňování #odkazů v panelu (bez ignorovaných adresářů). */
  async workspaceFiles(): Promise<string[]> {
    try {
      const host = this.host ?? this.newEngine().hostRef();
      return await host.listFiles("**/*", 4000);
    } catch {
      return [];
    }
  }

  /** Co je právě otevřené v editoru (pro tlačítka „přidat soubor / výběr“). */
  editorInfo(): { path?: string; selection?: string } | undefined {
    const a = this.activeEditor();
    if (!a) return undefined;
    return { path: a.path, selection: a.selectionRange };
  }

  /** Obsah souborů odkázaných přes #soubor, jako příloha k textu uživatele. */
  private async refsBlock(text: string): Promise<string> {
    if (!parseRefs(text).length) return "";
    try {
      const host = this.host ?? this.newEngine().hostRef();
      const block = renderRefs(await resolveRefs(host, text, this.activeEditor()));
      return block ? "\n\n" + block : "";
    } catch {
      return "";
    }
  }

  private drainNotes(): string[] {
    const s = this.session.current;
    const userNotes = (s?.notes ?? []).splice(0).map((n) => `User note while waiting: ${n}`);
    if (s) s.notes = [];
    return [...this.pendingNotes.splice(0), ...userNotes, ...this.review.drainNotes()];
  }

  /** Bez vyskakovacích oken: stav je vidět v panelu a ve stavovém řádku. */
  private notifyCopied(prompt: string, turn: number, mode: "text" | "file"): void {
    vscode.window.setStatusBarMessage(
      mode === "file"
        ? `$(clippy) Whisper: prompt pro kolo ${turn} je ve schránce jako soubor .txt (${kb(prompt)})`
        : `$(clippy) Whisper: prompt pro kolo ${turn} je ve schránce (${kb(prompt)})`,
      6000,
    );
    this.logLine(`📋 Kolo ${turn}: prompt zkopírován (${kb(prompt)}).`);
  }

  private async notifyDone(): Promise<void> {
    const pending = this.review.hasPending;
    vscode.window.setStatusBarMessage(`$(check) Whisper dokončil úkol${pending ? ", zbývají změny ke schválení" : ""}`, 8000);
  }

  private pushItem(item: Omit<TranscriptEvent, "at" | "session">): void {
    const ev: TranscriptEvent = { at: new Date().toISOString(), session: this.session.current?.id ?? "-", ...item };
    this.items.push(ev);
    if (this.items.length > 400) this.items.shift();
    this.logLine(`${item.kind}${item.turn ? ` ${item.turn}` : ""}: ${(item.text ?? "").split("\n")[0].slice(0, 160)}`);
    this.changeEmitter.fire();
  }

  private cancelWait(): void {
    this.cts?.cancel();
    this.cts?.dispose();
    this.cts = undefined;
  }

  private logLine(line: string): void {
    const stamp = new Date().toLocaleTimeString("cs-CZ");
    this.output.appendLine(`[${stamp}] ${line}`);
    this.log.push(line);
    if (this.log.length > 300) this.log.shift();
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.cancelWait();
    this.output.dispose();
    this.changeEmitter.dispose();
  }
}

function kb(s: string): string {
  return `${(s.length / 1000).toFixed(1)} k znaků`;
}

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e] ?? _);
}

