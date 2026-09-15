import { readGlobalInstructions, readGlobalRules } from "../global/GlobalConfig";
import { loadHooks, runHooks } from "../hooks/Hooks";
import { Host } from "../host/Host";

/** Projektová pravidla chování agenta (jedno na řádek). */
export const RULES_FILE = ".whisper/rules.md";
import {
  BuilderOptions,
  buildCorrectionPrompt,
  classifyProse,
  documentPathInTask,
  buildInitialPrompt,
  buildPreamble,
  buildResultsPrompt,
  buildResumePrompt,
  buildSuggestPrompt,
  ProjectContext,
  SuggestionHistory,
  summarizeTurn,
} from "../protocol/PromptBuilder";
import { parseReply } from "../protocol/ResponseParser";

/** Akce, které samy nic nemění: blok složený jen z nich je „jen poznámka“. */
const REMARK_TOOLS = new Set(["status", "dialog", "plan", "done", "think"]);
import { Action, ActionResult, ParsedReply } from "../protocol/schema";
import { toolBundle } from "../tools/bundle";
import { nowId } from "../protocol/text";
import { SessionData, Suggestion, TurnRecord } from "../session/SessionData";
import { collectDiagnosticsSettled } from "../tools/diagnostics";
import { renderTree } from "../tools/fs";
import { ChangeListener, PLAN_FILE, RunContext, RunOutcome, ToolRunner } from "../tools/ToolRunner";

/**
 * Ořízne chatové věty kolem dokumentu napsaného do chatu: úvod před prvním nadpisem
 * („Here is the proposal:“, omluvy) a závěr za posledním obsahem (oddělovač, dotaz, nabídka).
 */
export function trimChatter(body: string): { body: string; dropped: string[] } {
  const dropped: string[] = [];
  let lines = body.replace(/\r\n/g, "\n").split("\n");
  const firstHeading = lines.findIndex((l) => /^#{1,6}\s/.test(l));
  if (firstHeading > 0 && firstHeading <= 15) {
    const intro = lines.slice(0, firstHeading).join("\n").trim();
    if (intro) dropped.push(intro);
    lines = lines.slice(firstHeading);
  }
  // závěr: odstavce za koncem, které jsou oddělovač, krátká otázka nebo nabídka „chcete, abych…“
  const paras = lines.join("\n").split(/\n{2,}/);
  while (paras.length > 1) {
    const last = paras[paras.length - 1].trim();
    const isRule = /^-{3,}$|^\*{3,}$|^```[\w-]*$/.test(last);
    const isQuestion = last.length <= 400 && /\?\s*$/.test(last) && !/^#{1,6}\s/.test(last);
    const isOffer = last.length <= 400 && /^(chcete|mám|mohu|shall i|would you like|let me know|do you want)/i.test(last);
    // krátký uvozovací odstavec „A pro ten tvůj nástroj:“ před blokem, který následoval
    const isLeadIn = last.length <= 200 && /:\s*$/.test(last) && !/^#{1,6}\s/.test(last) && !/^[-*]\s|^\d+\.\s/.test(last);
    if (isRule || isQuestion || isOffer || isLeadIn) {
      if (!isRule) dropped.push(last);
      paras.pop();
      continue;
    }
    break;
  }
  return { body: paras.join("\n\n").trim(), dropped };
}

export type StepResult =
  | { kind: "correction"; prompt: string; errors: string[] }
  | { kind: "next"; prompt: string; record: TurnRecord; attachments: string[]; review?: { round: number; files: string[] } }
  | { kind: "done"; summary: string; record: TurnRecord }
  | { kind: "ask"; question: string; options?: string[]; multi?: boolean; record: TurnRecord };

export interface EngineOptions extends BuilderOptions {
  treeMaxEntries: number;
}

/**
 * Jádro smyčky nezávislé na UI: sestaví prompt, zpracuje odpověď modelu,
 * vykoná akce (včetně hooků), udržuje plán a návrhy. Mutuje předaný SessionData.
 */
export class TurnEngine {
  private readonly runner: ToolRunner;
  private preamble = "";

  constructor(
    private readonly host: Host,
    private readonly opts: EngineOptions,
    listener?: ChangeListener,
  ) {
    this.runner = new ToolRunner(host, opts.resultMaxChars, listener);
  }

  /**
   * Před novým úkolem odloží plán předchozího sezení: hotový plán (vše odškrtnuté) smaže,
   * rozpracovaný archivuje do .whisper/plan-<session>.md. Nový úkol tak nezačíná s cizím checklistem.
   */
  async archivePlan(previousSessionId?: string): Promise<void> {
    if (!(await this.host.exists(PLAN_FILE))) return;
    const plan = await this.host.readFile(PLAN_FILE);
    const open = plan.split("\n").some((l) => /^\s*- \[ \]/.test(l));
    if (open && previousSessionId) await this.host.writeFile(`.whisper/plan-${previousSessionId}.md`, plan);
    await this.host.deleteFile(PLAN_FILE);
  }

  async gatherContext(active?: ProjectContext["active"], skills?: ProjectContext["skills"]): Promise<ProjectContext> {
    const ctx: ProjectContext = { workspaceName: this.host.workspaceName, tree: await renderTree(this.host, this.opts.treeMaxEntries) };
    if (await this.host.exists("WHISPER.md")) ctx.instructions = await this.host.readFile("WHISPER.md");
    if (await this.host.exists(PLAN_FILE)) ctx.plan = await this.host.readFile(PLAN_FILE);
    // globální chování agenta (~/.whisper) + projektová pravidla (.whisper/rules.md)
    const globalInstructions = readGlobalInstructions();
    if (globalInstructions) ctx.globalInstructions = globalInstructions;
    const rules = [...readGlobalRules()];
    if (await this.host.exists(RULES_FILE)) {
      for (const l of (await this.host.readFile(RULES_FILE)).split(/\r?\n/)) {
        const r = l.replace(/^\s*[-*]\s+/, "").trim();
        if (r && !r.startsWith("#") && !rules.includes(r)) rules.push(r);
      }
    }
    if (rules.length) ctx.rules = rules;
    // co už existuje (pro návrhy, aby se neopakovaly)
    const hooks = await loadHooks(this.host);
    const policy = this.host.policy;
    ctx.existing = {
      hooks: hooks.map((h) => `${h.match} → ${h.run}${h.cwd ? ` (cwd ${h.cwd})` : ""}`),
      allowPatterns: policy.allowPatterns ?? [],
      autoAllow: policy.autoAllow,
      planOpen: (ctx.plan ?? "")
        .split(/\r?\n/)
        .filter((l) => /^\s*[-*]\s+\[ \]/.test(l))
        .map((l) => l.replace(/^\s*[-*]\s+\[ \]\s*/, "").trim()),
    };
    if (active) ctx.active = active;
    if (skills?.length) ctx.skills = skills;
    const diag = await this.host.diagnostics();
    if (diag) ctx.diagnostics = diag;
    return ctx;
  }

  private optsFor(session: SessionData): EngineOptions {
    return { ...this.opts, planMode: !!session.planMode };
  }

  async initialPrompt(session: SessionData, ctx: ProjectContext): Promise<string> {
    const o = this.optsFor(session);
    this.preamble = buildPreamble(ctx, o);
    return buildInitialPrompt(session.id, session.task, ctx, o);
  }

  /**
   * whisper.bundle.initial = full: svazek s celou codebase k úvodnímu promptu (a k novému kontextu).
   * Doplní ctx.initialBundle (text do promptu) a vrátí přílohy; jinak prázdné pole.
   */
  async attachInitialBundle(session: SessionData, ctx: ProjectContext, turn: number): Promise<string[]> {
    if (this.opts.initialBundle !== "full") return [];
    const maxChars = String(this.opts.initialBundleMaxChars ?? 400_000);
    const b = await toolBundle(this.host, { all: "true", maxChars }, turn, 0);
    const output = b.output ?? "";
    if (b.status !== "ok" || !b.attachments?.length) {
      this.host.log(`⚠ úvodní svazek celé codebase se nepovedl: ${output.split("\n")[0]}`);
      return [];
    }
    const skipped = (output.match(/^Skipped:\n((?:  .*\n?)+)/m)?.[1] ?? "").split("\n").filter((l) => l.trim()).length;
    ctx.initialBundle = { file: String(b.meta?.file ?? b.attachments[0]), files: Number(b.meta?.files ?? 0), chars: Number(b.meta?.chars ?? 0), skipped };
    this.host.log(`📦 úvodní svazek celé codebase: ${ctx.initialBundle.file} (${ctx.initialBundle.files} souborů, ${ctx.initialBundle.chars} znaků)`);
    void session;
    return b.attachments;
  }

  async resumePrompt(session: SessionData, ctx: ProjectContext): Promise<string> {
    const o = this.optsFor(session);
    this.preamble = buildPreamble(ctx, o);
    return buildResumePrompt(session.id, session.task, session.turn, ctx, session.summaries, o);
  }

  /** Prompt s žádostí o návrhy (skilly, hooky, povolení, úkoly) z přehledu průběhu. */
  suggestPrompt(session: SessionData, transcriptSummary: string, ctx: ProjectContext, history?: SuggestionHistory): string {
    const o = this.optsFor(session);
    this.preamble = buildPreamble(ctx, o);
    return buildSuggestPrompt(session.id, session.turn, transcriptSummary, ctx, o, history);
  }

  /**
   * Prompt s odpovědí uživatele na <ask>. Přiloží i výsledky akcí, které model
   * poslal ve stejném bloku jako otázku (ty ještě neviděl).
   */
  async answerPrompt(session: SessionData, answer: string, notes: string[]): Promise<string> {
    const last = session.history[session.history.length - 1];
    const pending = last && last.actions.some((a) => a.tool === "ask") ? last.results : [];
    if (last) last.undelivered = false;
    return buildResultsPrompt(
      session.id,
      session.turn,
      pending,
      { userNotes: [`Answer to your question: ${answer}`, ...notes], parseErrors: last?.errors, docTarget: await this.docTarget(session) },
      this.optsFor(session),
      session.summaries,
      this.statelessPreamble(session),
    );
  }

  parse(text: string, expectedTurn?: number): ParsedReply {
    return parseReply(text, expectedTurn);
  }

  /** Dokument ze zadání, který ještě neexistuje: připomínka formátu pak ukáže tvar odpovědi s <write>. */
  private async docTarget(session: SessionData): Promise<string | undefined> {
    const p = documentPathInTask(session.task);
    if (!p) return undefined;
    return (await this.host.exists(p)) ? undefined : p;
  }

  /** Text odpovědi bez protokolových řádků a vnějšího ohrazení; null, když to nevypadá jako dokument. */
  private static documentBody(text: string): string | null {
    let body = text
      .replace(/\r\n/g, "\n")
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/^\s*<\/?whisper[^>]*>\s*$/gm, "")
      .replace(/^\s*<write\b[^>]*>\s*$/gm, "")
      .replace(/^\s*<\/write>\s*$/gm, "")
      .replace(/^\s*<(status|done)>[\s\S]*?<\/\1>\s*$/gm, "")
      .trim();
    const fenced = body.match(/^```[\w-]*[ \t]*\n([\s\S]*?)\n```[ \t]*$/);
    if (fenced) body = fenced[1].trim();
    // osamělé ohrazení (blok byl ve fence a ta zůstala mimo něj): lichý počet fence řádků, krajní pryč
    if ((body.match(/^```/gm) ?? []).length % 2 === 1) {
      if (/\n```[ \t]*$/.test(body)) body = body.replace(/\n```[ \t]*$/, "").trim();
      else if (/^```[\w-]*[ \t]*\n/.test(body)) body = body.replace(/^```[\w-]*[ \t]*\n/, "").trim();
    }
    return classifyProse(body) === "document" ? body : null;
  }

  /**
   * „Dutý“ <write>: dokument je v chatu mimo blok a tělo write jen odkazuje („text zkopíruj z nadpisu
   * výše“). Tělo nahradíme dokumentem z chatu. Jen pro .md/.txt, jen když je tělo krátké a dokument
   * mimo blok zjevný.
   */
  private static rescueHollowWrite(parsed: ParsedReply): { action: Action; replacement: Action; note: string } | null {
    const write = parsed.actions.find((a) => a.tool === "write" && /\.(md|markdown|txt)$/i.test(String(a.attrs.path ?? "")));
    if (!write) return null;
    const body = (write.body ?? "").trim();
    if (body.length >= 400 || classifyProse(body) === "document") return null;
    const doc = TurnEngine.documentBody(parsed.outside);
    if (!doc) return null;
    const trimmed = trimChatter(doc);
    const path = String(write.attrs.path);
    return {
      action: write,
      replacement: { ...write, body: trimmed.body + "\n" },
      note:
        `Format requirement: the document itself must be INSIDE <write path="${path}">…</write>; your <write> body had only ` +
        `${body.split("\n").length} short line(s) (${JSON.stringify(body.slice(0, 60))}) while the document was written as chat text ` +
        `outside the block, which the tool discards. This once the tool used your chat text as the file content (see the write result). ` +
        `From now on write the document once, inside <write>.`,
    };
  }

  /** Blok, který nic nedělá (jen poznámka, plán nebo done): skutečná práce mohla zůstat v chatu mimo blok. */
  private static remarksOnly(actions: Action[]): boolean {
    return actions.length > 0 && actions.every((a) => REMARK_TOOLS.has(a.tool));
  }

  /**
   * Odpověď bez použitelného bloku (source="raw"), nebo blok jen s poznámkou a dokument v chatu mimo něj
   * (source="outside"): když je to zjevně dokument a z odpovědi nebo ze zadání je jasná cílová cesta, agent
   * ho zapíše sám (jako běžný <write>, tedy i se schvalováním změn) a modelu to oznámí. Vrací akci
   * k vykonání, nebo null, když záchrana nedává smysl.
   */
  private async rescueDocument(session: SessionData, parsed: ParsedReply, source: "raw" | "outside"): Promise<{ action: Action; note: string } | null> {
    const text = source === "raw" ? parsed.raw : parsed.outside;
    // cesta: z rozepsaného <write path=…> (i neuzavřeného), jinak ze zadání
    const fromWrite = text.match(/<write\b[^>]*\bpath\s*=\s*["']([^"']+)["']/)?.[1];
    const path = fromWrite ?? documentPathInTask(session.task);
    if (!path) return null;
    const body = TurnEngine.documentBody(text);
    if (!body) return null;
    if (await this.host.exists(path)) return null; // existující dokument nepřepisovat naslepo
    const trimmed = trimChatter(body);
    const why =
      source === "raw"
        ? `Format requirement: every reply must contain the <whisper> block with the work inside it; yours had no usable block (${parsed.errors[0] ?? "no actions"}). `
        : `Format requirement: the work itself must be INSIDE the <whisper> block; your block held only ${parsed.actions.map((a) => `<${a.tool}>`).join(", ")} while the document was written as chat text outside it, which the tool discards. `;
    return {
      action: { tool: "write", attrs: { path }, body: trimmed.body + "\n", index: 0 },
      note:
        why +
        `This once the tool recovered: the task asks for ${path}, your text looked like that document, so it was saved as ${path} (see the write result)` +
        `${trimmed.dropped.length ? `; the chat sentences around it were left out (${trimmed.dropped.map((d) => JSON.stringify(d.slice(0, 60))).join(", ")})` : ""}. ` +
        `The tool cannot do this in general, so from now on put the document inside <write path="${path}">…</write> in the block. ` +
        `Continue: check the file (it is your text), fix anything with <edit path="${path}" section="## Heading"> or hunks, ask with <ask> if you need a decision, then <done>.`,
    };
  }

  /**
   * Odpověď bez bloku (nebo jen s poznámkou), která není dokument, ale zmiňuje existující soubory
   * („pošlete mi obsah todo/model.py“, „v ts-app/src/model.ts změňte…“): agent je přečte sám, aby model
   * dostal skutečná data a s nimi i připomínku formátu. Vrací akce <read>, nebo null.
   */
  private async rescueReads(parsed: ParsedReply): Promise<{ actions: Action[]; note: string } | null> {
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const m of parsed.outside.matchAll(/(?<![\w/])((?:[\w.-]+\/)+[\w.-]+\.\w{1,10})(?![\w/])/g)) {
      const p = m[1].replace(/^\.\//, "");
      if (seen.has(p) || p.startsWith(".whisper/")) continue;
      seen.add(p);
      if (await this.host.exists(p)) paths.push(p);
      if (paths.length >= 8) break;
    }
    if (paths.length === 0) return null;
    const had = parsed.actions.length ? `held only ${parsed.actions.map((a) => `<${a.tool}>`).join(", ")}` : "had no block at all";
    return {
      actions: paths.map((path, index) => ({ tool: "read", attrs: { path }, index })),
      note:
        `Format requirement: every reply must contain the <whisper> block with the work inside it; yours ${had}, so nothing was applied: ` +
        `the tool does not execute prose or fenced code outside the block, and the user will not retype it by hand. ` +
        `To move on, the tool read the files your text mentions (results above). Now send the actual change as actions inside ` +
        `<whisper turn="N">: <edit path="…"> with SEARCH/REPLACE hunks (or <write> for new files), <run> for the tests, then <done>. ` +
        `Questions go into <ask options="A|B">…</ask> inside the block.`,
    };
  }

  /** Uloží odpověď bez bloku pro pozdější použití a vrátí cestu (nebo undefined, když se nepovede). */
  private async saveProse(session: SessionData, parsed: ParsedReply): Promise<string | undefined> {
    const rel = `.whisper/out/reply-${session.turn}-${session.noBlockReplies ?? 1}.md`;
    try {
      await this.host.writeFile(rel, parsed.raw);
      return rel;
    } catch {
      return undefined;
    }
  }

  /** Vykoná rozparsovanou odpověď pro aktuální kolo a připraví další krok. */
  async execute(session: SessionData, parsed: ParsedReply, promptChars: number, notes: string[] = [], ctx: RunContext = {}): Promise<StepResult> {
    const turn = session.turn;
    const agentNotes: string[] = [...parsed.notes];
    const noBlock = parsed.actions.length === 0;
    const remarksOnly = TurnEngine.remarksOnly(parsed.actions);
    if (noBlock || remarksOnly) {
      const rescued = await this.rescueDocument(session, parsed, noBlock ? "raw" : "outside");
      if (rescued) {
        // zápis jde před ostatní akce; případné <done> vynecháme, ať model soubor zkontroluje a formát si osvojí
        parsed = { ...parsed, actions: [rescued.action, ...parsed.actions.filter((a) => a.tool !== "done")] };
        agentNotes.push(rescued.note);
      } else {
        const isDoc = !!TurnEngine.documentBody(parsed.outside);
        // dokument ze zadání, který už existuje: opravný prompt má vést k editacím, ne k novému <write>
        const docPath = documentPathInTask(session.task);
        const existingDoc = docPath && (await this.host.exists(docPath)) ? docPath : undefined;
        // próza, která zmiňuje existující soubory („změňte v todo/model.py…“, „pošlete mi obsah…“):
        // soubory přečteme sami, model dostane skutečná data a s nimi připomínku formátu
        const reads = isDoc && existingDoc ? null : await this.rescueReads(parsed);
        if (reads) {
          parsed = { ...parsed, actions: [...reads.actions, ...parsed.actions.filter((a) => a.tool !== "done")] };
          agentNotes.push(reads.note);
        } else if (noBlock || isDoc) {
          // bez bloku, nebo dokument v chatu vedle bloku s pouhou poznámkou, který nešlo zachránit (cíl už existuje)
          session.noBlockReplies = (session.noBlockReplies ?? 0) + 1;
          const savedTo = await this.saveProse(session, parsed);
          const errors = noBlock
            ? parsed.errors
            : [`The block held only ${parsed.actions.map((a) => `<${a.tool}>`).join(", ")}; the document was written outside the block, which the tool discards.`];
          const prompt = buildCorrectionPrompt(session.id, turn, errors, {
            task: session.task,
            prose: noBlock ? parsed.prose || parsed.raw : parsed.outside,
            attempt: session.noBlockReplies,
            userNotes: notes,
            savedTo,
            existingDoc,
            preamble: this.statelessPreamble(session),
          });
          return { kind: "correction", prompt, errors };
        }
      }
    }
    session.noBlockReplies = 0;
    const hollow = TurnEngine.rescueHollowWrite(parsed);
    if (hollow) {
      parsed = { ...parsed, actions: parsed.actions.map((a) => (a === hollow.action ? hollow.replacement : a)) };
      agentNotes.push(hollow.note);
    }
    const startedAt = Date.now();
    const outcome = await this.runner.runAll(parsed.actions, turn, ctx);
    if (ctx.signal?.aborted) {
      // uživatel přerušil: model dostane, co proběhlo, kde to stálo a jak dlouho
      const stuck = outcome.results.find((r) => r.meta?.exit === "interrupted");
      const skipped = outcome.results.filter((r) => r.meta?.interrupted === "before start").length;
      notes = [
        `The user INTERRUPTED this turn after ${((Date.now() - startedAt) / 1000).toFixed(0)}s of execution` +
          (stuck ? `, while <${stuck.tool}> "${String(stuck.meta?.command ?? stuck.attrs.path ?? "")}" was running (${stuck.meta?.duration}). Its partial output is in its result.` : ".") +
          (skipped ? ` ${skipped} later action(s) were not executed (status="skipped").` : "") +
          " Explain briefly what that step was waiting for, then continue with a safer approach: shorter commands, probe= for GUI apps or servers, smaller batches, or ask the user.",
        ...notes,
      ];
    }
    // hooky uživatele (lint, testy…) po změně souborů; jejich selhání vidí model jako výsledek
    if (!ctx.signal?.aborted) outcome.results.push(...(await runHooks(this.host, outcome.changedPaths)));

    const statusNote = outcome.statuses.join(" ") || undefined;
    const record: TurnRecord = {
      turn,
      at: new Date().toISOString(),
      promptChars,
      actions: parsed.actions,
      results: outcome.results,
      prose: parsed.prose || undefined,
      status: statusNote,
      errors: parsed.errors.length ? parsed.errors : undefined,
      dialog: outcome.dialog.length ? outcome.dialog : undefined,
    };
    // výsledky kola s <ask>, na které uživatel odpověděl v chatu (agent je neposlal), jdou s tímto kolem
    const prev = session.history[session.history.length - 1];
    const carried = prev?.undelivered ? prev.results.filter((r) => r.tool !== "ask") : [];
    if (prev) prev.undelivered = false;
    session.history.push(record);
    session.summaries.push(summarizeTurn(turn, outcome.results, statusNote));
    session.turn = turn + 1;
    if (outcome.plan) session.plan = outcome.plan;
    if (outcome.suggestions.length) {
      session.suggestions = [
        ...(session.suggestions ?? []),
        ...outcome.suggestions.map((s): Suggestion => ({ id: nowId(), kind: s.kind as Suggestion["kind"], scope: s.scope, title: s.title, body: s.body, update: s.update, turn })),
      ];
    }

    // změněné soubory úlohy: pro revizi před dokončením
    if (outcome.changedPaths.length) {
      session.changedFiles = [...new Set([...(session.changedFiles ?? []), ...outcome.changedPaths])];
      session.changedSinceReview = [...new Set([...(session.changedSinceReview ?? []), ...outcome.changedPaths])];
    }
    const failed = outcome.results.filter((r) => r.status !== "ok");
    let review: { round: number; files: string[] } | undefined;
    if (outcome.done !== undefined && failed.length === 0) {
      const r = await this.reviewBeforeDone(session, outcome, turn);
      if (!r) return { kind: "done", summary: outcome.done, record };
      notes = [r.note, ...notes];
      if (r.bundle) outcome.results.push(r.bundle);
      review = { round: r.round, files: r.files };
    } else if (outcome.done !== undefined) {
      notes = [
        `You sent <done>, but ${failed.length} action(s) in that block did not succeed (see results). The task continues: fix the problem, or send <done> again if the failure is acceptable and explain why.`,
        ...notes,
      ];
    }
    if (outcome.question !== undefined) {
      record.undelivered = true;
      return { kind: "ask", question: outcome.question, options: outcome.questionOptions, multi: outcome.questionMulti, record };
    }

    const diagnostics = outcome.changedFiles ? await collectDiagnosticsSettled(this.host) : undefined;
    const prompt = buildResultsPrompt(
      session.id,
      session.turn,
      [...carried, ...outcome.results],
      { diagnostics, userNotes: notes, parseErrors: parsed.errors, agentNotes, docTarget: await this.docTarget(session) },
      this.optsFor(session),
      session.summaries,
      this.statelessPreamble(session),
    );
    // i přílohy z kola s <ask>, které modelu ještě nedošly (uživatel odpověděl v chatu)
    return { kind: "next", prompt, record, review, attachments: [...carried, ...outcome.results].flatMap((r) => r.attachments ?? []) };
  }

  /**
   * Revize před dokončením: první <done> po změnách souborů není finální. Model dostane svazek
   * s celým aktuálním obsahem všech souborů změněných v úloze a výzvu zkontrolovat celou práci
   * (i mimo tyto soubory, klidně na víc kol) a skončit <done reviewed="true">. Každá další změna
   * vyvolá další revizi; <done> bez změn od poslední výzvy je finální. Vrací null = done platí.
   */
  private async reviewBeforeDone(
    session: SessionData,
    outcome: RunOutcome,
    turn: number,
  ): Promise<{ note: string; bundle?: ActionResult; round: number; files: string[] } | null> {
    if (this.opts.reviewBeforeDone === false) return null;
    const pending = session.changedSinceReview ?? [];
    if (pending.length === 0) return null;
    const files: string[] = [];
    for (const p of session.changedFiles ?? []) if (await this.host.exists(p)) files.push(p);
    const round = (session.reviewRounds ?? 0) + 1;
    session.reviewRounds = round;
    session.changedSinceReview = [];
    let bundle: ActionResult | undefined;
    if (files.length) {
      const b = await toolBundle(this.host, { paths: files.join(", ") }, turn, 90 + round);
      if (b.status === "ok") bundle = b;
    }
    const attached = bundle
      ? `Attached is a bundle with the COMPLETE current content of every file you changed in this task (${files.length}: ${files.join(", ")}).`
      : `The files you changed in this task: ${files.join(", ") || "(none left)"}; read them with <read> or <bundle>.`;
    const sent = outcome.doneReviewed ? '<done reviewed="true">' : "<done>";
    const head =
      round === 1
        ? `REVIEW BEFORE DONE: you sent ${sent}, but in this session the first <done> after file changes is not final; review the work first. ${attached}`
        : `REVIEW BEFORE DONE (round ${round}): you sent ${sent}, but since the last review you changed ${pending.join(", ")}. ${attached} Review the new changes and their effect on the rest.`;
    const note =
      `${head} Check the WHOLE work against the task, not only these files: is everything the task asked for done, in every place it belongs ` +
      `(both versions, tests, docs, config)? Anything forgotten, inconsistent, half-done or left as a placeholder? Does every file read as valid, ` +
      `complete code or text? Read other files, grep or run tests if that helps; take several turns if needed. Fix what you find with small <edit> hunks. ` +
      `When you are satisfied, finish with <done reviewed="true"> and a summary of what you checked. If you change any file, the tool asks for one more review.`;
    return { note, bundle, round, files };
  }

  /** Přílohy (svazky, obrázky) z kola s <ask>, které modelu ještě nebyly doručeny. */
  undeliveredAttachments(session: SessionData): string[] {
    const last = session.history[session.history.length - 1];
    return last?.undelivered ? last.results.flatMap((r) => r.attachments ?? []) : [];
  }

  /**
   * Znovu vykoná jednu akci posledního kola (podle jejího indexu v bloku), nahradí její
   * výsledek v historii a vrátí přestavěný prompt. Pro headless ladění agenta.
   */
  async rerunAction(session: SessionData, actionIndex: number): Promise<string | undefined> {
    const last = session.history[session.history.length - 1];
    const action = last?.actions.find((a) => a.index === actionIndex);
    if (!last || !action) return undefined;
    let pos = 0;
    for (const a of last.actions) {
      if (a.index === action.index) break;
      if (!["status", "ask", "done", "dialog"].includes(a.tool)) pos++;
    }
    const outcome = await this.runner.runAll([action], last.turn);
    if (outcome.results[0]) last.results.splice(pos, 1, outcome.results[0]);
    session.summaries[session.summaries.length - 1] = summarizeTurn(last.turn, last.results, last.status);
    return this.rebuildLastPrompt(session);
  }

  /** Znovu sestaví prompt s výsledky posledního vykonaného kola (např. po změně limitů). */
  rebuildLastPrompt(session: SessionData, notes: string[] = []): string | undefined {
    const last = session.history[session.history.length - 1];
    if (!last) return undefined;
    return buildResultsPrompt(
      session.id,
      session.turn,
      last.results,
      { userNotes: notes, parseErrors: last.errors },
      this.optsFor(session),
      session.summaries,
      this.statelessPreamble(session),
    );
  }

  private statelessPreamble(session: SessionData): string | undefined {
    return session.mode === "stateless" ? this.preamble : undefined;
  }
}
