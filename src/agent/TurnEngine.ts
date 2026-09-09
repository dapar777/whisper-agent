import { readGlobalInstructions, readGlobalRules } from "../global/GlobalConfig";
import { runHooks } from "../hooks/Hooks";
import { Host } from "../host/Host";

/** Projektová pravidla chování agenta (jedno na řádek). */
export const RULES_FILE = ".whisper/rules.md";
import {
  BuilderOptions,
  buildCorrectionPrompt,
  buildInitialPrompt,
  buildPreamble,
  buildResultsPrompt,
  buildResumePrompt,
  buildSuggestPrompt,
  ProjectContext,
  summarizeTurn,
} from "../protocol/PromptBuilder";
import { parseReply } from "../protocol/ResponseParser";
import { ParsedReply } from "../protocol/schema";
import { nowId } from "../protocol/text";
import { SessionData, Suggestion, TurnRecord } from "../session/SessionData";
import { collectDiagnosticsSettled } from "../tools/diagnostics";
import { renderTree } from "../tools/fs";
import { ChangeListener, PLAN_FILE, RunContext, ToolRunner } from "../tools/ToolRunner";

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
  suggestPrompt(session: SessionData, transcriptSummary: string, ctx: ProjectContext): string {
    const o = this.optsFor(session);
    this.preamble = buildPreamble(ctx, o);
    return buildSuggestPrompt(session.id, session.turn, transcriptSummary, ctx, o);
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

  parse(text: string): ParsedReply {
    return parseReply(text);
  }

  /** Vykoná rozparsovanou odpověď pro aktuální kolo a připraví další krok. */
  async execute(session: SessionData, parsed: ParsedReply, promptChars: number, notes: string[] = [], ctx: RunContext = {}): Promise<StepResult> {
    const turn = session.turn;
    if (parsed.actions.length === 0) {
      return { kind: "correction", prompt: buildCorrectionPrompt(session.id, turn, parsed.errors), errors: parsed.errors };
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
    };
    session.history.push(record);
    session.summaries.push(summarizeTurn(turn, outcome.results, statusNote));
    session.turn = turn + 1;
    if (outcome.plan) session.plan = outcome.plan;
    if (outcome.suggestions.length) {
      session.suggestions = [
        ...(session.suggestions ?? []),
        ...outcome.suggestions.map((s): Suggestion => ({ id: nowId(), kind: s.kind as Suggestion["kind"], scope: s.scope, title: s.title, body: s.body, turn })),
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
      { diagnostics, userNotes: notes, parseErrors: parsed.errors },
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
      if (!["status", "ask", "done"].includes(a.tool)) pos++;
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
