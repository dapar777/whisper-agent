import { Host } from "../host/Host";
import { applyHunks, parseHunks } from "../protocol/edit";
import { OK_RUN_OUTPUT_MAX } from "../protocol/PromptBuilder";
import { Action, ActionResult } from "../protocol/schema";
import { isProtectedPath } from "../safety/Policy";
import { toolDiagnostics } from "./diagnostics";
import { toolGlob, toolLs, toolRead } from "./fs";
import { toolGrep } from "./grep";
import { toolRun } from "./run";
import { toolBundle } from "./bundle";
import { takeScreenshot } from "./screenshot";

/** Napojení na review změn (ve VS Code); headless běh ho nepotřebuje. */
export interface ChangeListener {
  onWillChange(path: string, kind: "create" | "modify", baseline: string, turn: number): void;
  onWillDelete(path: string, content: string, turn: number): void;
  /** volitelné schválení před zápisem; undefined = vždy povoleno */
  approve?(path: string, before: string, after: string): Promise<boolean>;
}

export interface SuggestionDraft {
  kind: string;
  scope: "project" | "global";
  title: string;
  body: string;
  update?: string;
  /** kind="script": jazyk a název souboru */
  lang?: string;
  file?: string;
}

export interface RunOutcome {
  results: ActionResult[];
  /** true, pokud některá akce zapsala/smazala soubor */
  changedFiles: boolean;
  changedPaths: string[];
  statuses: string[];
  /** přímé výměny v chatu mimo protokol (otázka modelu, odpověď/upřesnění uživatele) */
  dialog: { from: "model" | "user"; text: string }[];
  /** nový/aktualizovaný plán (markdown) */
  plan?: string;
  suggestions: SuggestionDraft[];
  question?: string;
  /** možnosti odpovědi u <ask options="A|B">; multi = lze vybrat více */
  questionOptions?: string[];
  questionMulti?: boolean;
  done?: string;
}

export const PLAN_FILE = ".whisper/plan.md";

/** Průběžné informace o vykonávání (přerušení uživatelem, právě běžící akce). */
export interface RunContext {
  signal?: AbortSignal;
  onStart?: (action: Action) => void;
  onEnd?: (action: Action, durationMs: number) => void;
}
const SUGGEST_KINDS = new Set(["skill", "script", "whisper", "rule", "hook", "allow", "setting", "task", "agent"]);

export class ToolRunner {
  constructor(
    private readonly host: Host,
    private readonly resultMaxChars: number,
    private readonly listener?: ChangeListener,
  ) {}

  async runAll(actions: Action[], turn: number, ctx: RunContext = {}): Promise<RunOutcome> {
    const outcome: RunOutcome = { results: [], changedFiles: false, changedPaths: [], statuses: [], dialog: [], suggestions: [] };
    for (const a of actions) {
      if (ctx.signal?.aborted) {
        if (!["status", "ask", "done", "dialog"].includes(a.tool)) {
          outcome.results.push({ tool: a.tool, attrs: a.attrs, status: "skipped", output: "Not executed: the user interrupted this turn before this action.", meta: { interrupted: "before start" } });
        }
        continue;
      }
      ctx.onStart?.(a);
      const started = Date.now();
      const r = await this.runOne(a, turn, outcome, ctx.signal);
      ctx.onEnd?.(a, Date.now() - started);
      if (!r) continue;
      if (r.meta?.duration === undefined && Date.now() - started > 1500) r.meta = { ...r.meta, duration: ((Date.now() - started) / 1000).toFixed(1) + "s" };
      outcome.results.push(r);
      const saveAbove = a.tool === "run" && r.status === "ok" ? Math.min(this.resultMaxChars, OK_RUN_OUTPUT_MAX) : this.resultMaxChars;
      if (r.output && r.output.length > saveAbove && a.tool !== "read") {
        r.fullOutputPath = await this.saveFullOutput(turn, a, r.output);
      }
      this.host.log(`${a.tool} ${a.attrs.path ?? a.attrs.pattern ?? a.attrs.title ?? ""} → ${r.status}${r.meta ? " " + JSON.stringify(r.meta) : ""}`);
    }
    return outcome;
  }

  private async runOne(a: Action, turn: number, outcome: RunOutcome, signal?: AbortSignal): Promise<ActionResult | undefined> {
    try {
      switch (a.tool) {
        case "read":
          return await toolRead(this.host, a.attrs);
        case "ls":
          return await toolLs(this.host, a.attrs);
        case "glob":
          return await toolGlob(this.host, a.attrs);
        case "grep":
          return await toolGrep(this.host, a.attrs);
        case "diagnostics":
          return await toolDiagnostics(this.host, a.attrs);
        case "write":
          return await this.write(a, turn, outcome);
        case "edit":
          return await this.edit(a, turn, outcome);
        case "delete":
          return await this.delete(a, turn, outcome);
        case "run":
          return await toolRun(this.host, a.attrs, a.body ?? "", turn, a.index, signal);
        case "screenshot":
          return await takeScreenshot(this.host, turn, a.index, { window: a.attrs.window, name: a.attrs.name });
        case "bundle":
          return await toolBundle(this.host, a.attrs, turn, a.index);
        case "plan":
          return await this.plan(a, outcome);
        case "suggest":
          return this.suggest(a, outcome);
        case "status":
          outcome.statuses.push(a.body ?? "");
          this.host.log(`● ${a.body ?? ""}`);
          return undefined;
        case "dialog": {
          const from = (a.attrs.from ?? "").toLowerCase() === "user" ? "user" : "model";
          outcome.dialog.push({ from, text: (a.body ?? "").trim() });
          this.host.log(`💬 ${from}: ${(a.body ?? "").trim().split("\n")[0].slice(0, 120)}`);
          return undefined;
        }
        case "ask": {
          outcome.question = a.body ?? "";
          const opts = (a.attrs.options ?? "")
            .split("|")
            .map((o) => o.trim())
            .filter(Boolean);
          if (opts.length) outcome.questionOptions = opts;
          outcome.questionMulti = /^(true|1|yes|ano)$/i.test(a.attrs.multi ?? "");
          return undefined;
        }
        case "done":
          outcome.done = a.body ?? "";
          return undefined;
        default:
          return { tool: a.tool, attrs: a.attrs, status: "error", output: `Unknown action ${a.tool}` };
      }
    } catch (e) {
      return { tool: a.tool, attrs: a.attrs, status: "error", output: (e as Error).message };
    }
  }

  private guard(path: string): string | null {
    this.host.assertInside(path);
    if (isProtectedPath(path, this.host.policy)) return `Path "${path}" is protected by policy; changes are not allowed.`;
    return null;
  }

  private async approve(path: string, before: string, after: string): Promise<boolean> {
    return this.listener?.approve ? this.listener.approve(path, before, after) : true;
  }

  private markChanged(outcome: RunOutcome, path: string): void {
    outcome.changedFiles = true;
    if (!outcome.changedPaths.includes(path)) outcome.changedPaths.push(path);
  }

  private async write(a: Action, turn: number, outcome: RunOutcome): Promise<ActionResult> {
    const path = a.attrs.path;
    const blocked = this.guard(path);
    if (blocked) return { tool: "write", attrs: a.attrs, status: "denied", output: blocked };
    const exists = await this.host.exists(path);
    const baseline = exists ? await this.host.readFile(path) : "";
    const content = ensureTrailingNewline(a.body ?? "", baseline);
    if (!(await this.approve(path, baseline, content))) {
      return { tool: "write", attrs: a.attrs, status: "denied", output: "The user declined this change." };
    }
    this.listener?.onWillChange(path, exists ? "modify" : "create", baseline, turn);
    await this.host.writeFile(path, content);
    this.markChanged(outcome, path);
    return { tool: "write", attrs: a.attrs, status: "ok", meta: { [exists ? "overwritten" : "created"]: `${content.split("\n").length} lines` } };
  }

  private async edit(a: Action, turn: number, outcome: RunOutcome): Promise<ActionResult> {
    const path = a.attrs.path;
    const blocked = this.guard(path);
    if (blocked) return { tool: "edit", attrs: a.attrs, status: "denied", output: blocked };
    if (!(await this.host.exists(path))) {
      return { tool: "edit", attrs: a.attrs, status: "error", output: `File not found: ${path}. Use <write> to create it.` };
    }
    const hunks = parseHunks(a.body ?? "");
    if (hunks.length === 0) {
      return { tool: "edit", attrs: a.attrs, status: "error", output: "No SEARCH/REPLACE hunks found. Format:\n<<<<<<< SEARCH\n(old)\n=======\n(new)\n>>>>>>> REPLACE" };
    }
    const baseline = await this.host.readFile(path);
    const res = applyHunks(baseline, hunks);
    const meta = { hunks: `${res.applied}/${hunks.length}` };
    if (res.applied === 0) {
      return { tool: "edit", attrs: a.attrs, status: "error", output: res.failures.map((f) => `Hunk ${f.hunk}: ${f.reason}`).join("\n\n"), meta };
    }
    if (!(await this.approve(path, baseline, res.content))) {
      return { tool: "edit", attrs: a.attrs, status: "denied", output: "The user declined this change.", meta };
    }
    this.listener?.onWillChange(path, "modify", baseline, turn);
    await this.host.writeFile(path, res.content);
    this.markChanged(outcome, path);
    const failText = res.failures.map((f) => `Hunk ${f.hunk} FAILED (others applied): ${f.reason}`).join("\n\n");
    return { tool: "edit", attrs: a.attrs, status: res.failures.length ? "error" : "ok", output: failText || undefined, meta };
  }

  private async delete(a: Action, turn: number, outcome: RunOutcome): Promise<ActionResult> {
    const path = a.attrs.path;
    const blocked = this.guard(path);
    if (blocked) return { tool: "delete", attrs: a.attrs, status: "denied", output: blocked };
    if (!(await this.host.exists(path))) return { tool: "delete", attrs: a.attrs, status: "error", output: `File not found: ${path}` };
    if (!(await this.host.confirmDelete(path))) return { tool: "delete", attrs: a.attrs, status: "denied", output: "The user declined the deletion." };
    const content = await this.host.readFile(path);
    this.listener?.onWillDelete(path, content, turn);
    await this.host.deleteFile(path);
    this.markChanged(outcome, path);
    return { tool: "delete", attrs: a.attrs, status: "ok" };
  }

  private async plan(a: Action, outcome: RunOutcome): Promise<ActionResult> {
    const body = (a.body ?? "").trim() + "\n";
    const items = (body.match(/^\s*[-*]\s+\[[ xX]\]/gm) ?? []).length;
    const done = (body.match(/^\s*[-*]\s+\[[xX]\]/gm) ?? []).length;
    if (items === 0) {
      return { tool: "plan", attrs: a.attrs, status: "error", output: "The plan must be a markdown checklist with `- [ ]` / `- [x]` items." };
    }
    await this.host.writeFile(PLAN_FILE, body);
    outcome.plan = body;
    return { tool: "plan", attrs: a.attrs, status: "ok", meta: { items, done } };
  }

  private suggest(a: Action, outcome: RunOutcome): ActionResult {
    const kind = (a.attrs.kind ?? "").toLowerCase();
    if (!SUGGEST_KINDS.has(kind)) {
      return { tool: "suggest", attrs: a.attrs, status: "error", output: `Unknown suggestion kind "${a.attrs.kind}"; use one of ${[...SUGGEST_KINDS].join(", ")}.` };
    }
    const scope = (a.attrs.scope ?? "").toLowerCase() === "global" ? "global" : "project";
    const update = a.attrs.update?.trim() || undefined;
    // u kind="script" nese lang/file jazyk a název souboru
    const lang = a.attrs.lang?.trim() || undefined;
    const file = a.attrs.file?.trim() || undefined;
    outcome.suggestions.push({ kind, scope, title: a.attrs.title ?? kind, body: (a.body ?? "").trim(), update, lang, file });
    return {
      tool: "suggest",
      attrs: { kind, scope, title: a.attrs.title ?? kind, ...(update ? { update } : {}), ...(lang ? { lang } : {}), ...(file ? { file } : {}) },
      status: "ok",
      meta: { queued: "awaiting user approval" },
    };
  }

  private async saveFullOutput(turn: number, a: Action, output: string): Promise<string> {
    const rel = `.whisper/out/${a.tool}-${turn}-${a.index}.txt`;
    try {
      await this.host.writeFile(rel, output);
      return rel;
    } catch {
      return "";
    }
  }
}

function ensureTrailingNewline(content: string, baseline: string): string {
  if (content.endsWith("\n")) return content;
  if (baseline && !baseline.endsWith("\n")) return content;
  return content + "\n";
}
