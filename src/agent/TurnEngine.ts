import { readGlobalInstructions, readGlobalRules } from "../global/GlobalConfig";
import { loadHooks, runHooks } from "../hooks/Hooks";
import { Host } from "../host/Host";

/** Projektová pravidla chování agenta (jedno na řádek). */
export const RULES_FILE = ".whisper/rules.md";
import {
  BuilderOptions,
  buildCorrectionPrompt,
  classifyProse,
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
import { Action, ParsedReply } from "../protocol/schema";
import { nowId } from "../protocol/text";
import { SessionData, Suggestion, TurnRecord } from "../session/SessionData";
import { collectDiagnosticsSettled } from "../tools/diagnostics";
import { renderTree } from "../tools/fs";
import { ChangeListener, PLAN_FILE, RunContext, ToolRunner } from "../tools/ToolRunner";

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
    const isRule = /^-{3,}$|^\*{3,}$/.test(last);
    const isQuestion = last.length <= 400 && /\?\s*$/.test(last) && !/^#{1,6}\s/.test(last);
    const isOffer = last.length <= 400 && /^(chcete|mám|mohu|shall i|would you like|let me know|do you want)/i.test(last);
    if (isRule || isQuestion || isOffer) {
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
  | { kind: "next"; prompt: string; record: TurnRecord; attachments: string[] }
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
  answerPrompt(session: SessionData, answer: string, notes: string[]): string {
    const last = session.history[session.history.length - 1];
    const pending = last && last.actions.some((a) => a.tool === "ask") ? last.results : [];
    return buildResultsPrompt(
      session.id,
      session.turn,
      pending,
      { userNotes: [`Answer to your question: ${answer}`, ...notes], parseErrors: last?.errors },
      this.optsFor(session),
      session.summaries,
      this.statelessPreamble(session),
    );
  }

  parse(text: string, expectedTurn?: number): ParsedReply {
    return parseReply(text, expectedTurn);
  }

  /**
   * Odpověď bez použitelného bloku: když je to zjevně dokument a z odpovědi nebo ze zadání je jasná
   * cílová cesta, agent ho zapíše sám (jako běžný <write>, tedy i se schvalováním změn) a modelu
   * to oznámí. Vrací akci k vykonání, nebo null, když záchrana nedává smysl.
   */
  private async rescueDocument(session: SessionData, parsed: ParsedReply): Promise<{ action: Action; note: string } | null> {
    const raw = parsed.raw.replace(/\r\n/g, "\n");
    // cesta: z rozepsaného <write path=…> (i neuzavřeného), jinak ze zadání
    const fromWrite = raw.match(/<write\b[^>]*\bpath\s*=\s*["']([^"']+)["']/)?.[1];
    const fromTask = session.task.match(/(?:^|[\s"'`(])((?:[\w.-]+\/)*[\w.-]+\.(?:md|markdown|txt))(?=$|[\s"'`),.;:])/)?.[1];
    const path = fromWrite ?? fromTask;
    if (!path) return null;
    // tělo: text bez protokolových řádků a bez vnějšího ohrazení
    let body = raw
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/^\s*<\/?whisper[^>]*>\s*$/gm, "")
      .replace(/^\s*<write\b[^>]*>\s*$/gm, "")
      .replace(/^\s*<\/write>\s*$/gm, "")
      .replace(/^\s*<(status|done)>[\s\S]*?<\/\1>\s*$/gm, "")
      .trim();
    const fenced = body.match(/^```[\w-]*[ \t]*\n([\s\S]*?)\n```[ \t]*$/);
    if (fenced) body = fenced[1].trim();
    if (classifyProse(body) !== "document") return null;
    if (await this.host.exists(path)) return null; // existující dokument nepřepisovat naslepo
    const trimmed = trimChatter(body);
    return {
      action: { tool: "write", attrs: { path }, body: trimmed.body + "\n", index: 0 },
      note:
        `Your reply had no usable <whisper> block (${parsed.errors[0] ?? "no actions"}). Because the task asks for the document ${path} and your text looked like it, ` +
        `the agent saved your text as ${path} (see the write result)${trimmed.dropped.length ? `; the chat sentences around it were left out (${trimmed.dropped.map((d) => JSON.stringify(d.slice(0, 60))).join(", ")})` : ""}. ` +
        `Next time put the document inside <write path="${path}">…</write> in the block. ` +
        `Continue: check the file (it is your text), fix anything with <edit path="${path}" section="## Heading"> or hunks, ask with <ask> if you need a decision, then <done>.`,
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
    if (parsed.actions.length === 0) {
      const rescued = await this.rescueDocument(session, parsed);
      if (!rescued) {
        session.noBlockReplies = (session.noBlockReplies ?? 0) + 1;
        const savedTo = await this.saveProse(session, parsed);
        // dokument ze zadání, který už existuje: opravný prompt má vést k editacím, ne k novému <write>
        const docPath = session.task.match(/(?:^|[\s"'`(])((?:[\w.-]+\/)*[\w.-]+\.(?:md|markdown|txt))(?=$|[\s"'`),.;:])/)?.[1];
        const existingDoc = docPath && (await this.host.exists(docPath)) ? docPath : undefined;
        const prompt = buildCorrectionPrompt(session.id, turn, parsed.errors, {
          task: session.task,
          prose: parsed.prose || parsed.raw,
          attempt: session.noBlockReplies,
          userNotes: notes,
          savedTo,
          existingDoc,
          preamble: this.statelessPreamble(session),
        });
        return { kind: "correction", prompt, errors: parsed.errors };
      }
      parsed = { ...parsed, actions: [rescued.action] };
      agentNotes.push(rescued.note);
    }
    session.noBlockReplies = 0;
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

    const failed = outcome.results.filter((r) => r.status !== "ok");
    if (outcome.done !== undefined && failed.length === 0) return { kind: "done", summary: outcome.done, record };
    if (outcome.done !== undefined) {
      notes = [
        `You sent <done>, but ${failed.length} action(s) in that block did not succeed (see results). The task continues: fix the problem, or send <done> again if the failure is acceptable and explain why.`,
        ...notes,
      ];
    }
    if (outcome.question !== undefined) return { kind: "ask", question: outcome.question, options: outcome.questionOptions, multi: outcome.questionMulti, record };

    const diagnostics = outcome.changedFiles ? await collectDiagnosticsSettled(this.host) : undefined;
    const prompt = buildResultsPrompt(
      session.id,
      session.turn,
      outcome.results,
      { diagnostics, userNotes: notes, parseErrors: parsed.errors, agentNotes },
      this.optsFor(session),
      session.summaries,
      this.statelessPreamble(session),
    );
    return { kind: "next", prompt, record, attachments: outcome.results.flatMap((r) => r.attachments ?? []) };
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
