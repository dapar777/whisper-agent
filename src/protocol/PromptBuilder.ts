import { ActionResult, TOOLS } from "./schema";

export interface BuilderOptions {
  mode: "stateful" | "stateless";
  maxChars: number;
  resultMaxChars: number;
  /** jazyk pro komunikaci s uživatelem (status/ask/done) */
  language: string;
  /** režim PLAN vynucený uživatelem (/plan) */
  planMode?: boolean;
  /** model smí automaticky zakládat plán u větších úkolů */
  planAuto?: boolean;
  /** model smí průběžně posílat <suggest> */
  continuousSuggest?: boolean;
  /** přímý dialog: model se ptá přímo v chatu a výměnu zapíše přes <dialog> */
  directDialog?: boolean;
}

export interface ProjectContext {
  workspaceName: string;
  /** obsah WHISPER.md, pokud existuje */
  instructions?: string;
  /** předrenderovaný strom projektu */
  tree: string;
  /** aktivní soubor a výběr */
  active?: { path: string; selection?: string; selectionRange?: string };
  diagnostics?: string;
  /** aktuální plán (markdown checklist), pokud existuje */
  plan?: string;
  /** globální instrukce uživatele (~/.whisper/WHISPER.md) */
  globalInstructions?: string;
  /** dodatečná pravidla chování agenta (globální + projektová), jedno na položku */
  rules?: string[];
  /** dostupné skilly (jen názvy a popisy) */
  skills?: { name: string; description: string }[];
  /** co už je nakonfigurované (pro návrhy, aby se neopakovaly) */
  existing?: {
    hooks?: string[];
    allowPatterns?: string[];
    autoAllow?: string[];
    planOpen?: string[];
    settings?: Record<string, unknown>;
    /** obsah existujících skillů (zkrácený), aby šlo navrhnout jejich úpravu místo nového */
    skillBodies?: { name: string; body: string }[];
  };
}

/** Historie dřívějších návrhů (z transkriptu), aby se nenavrhovalo znovu. */
export interface SuggestionHistory {
  approved: string[];
  rejected: string[];
}

export interface TurnSummary {
  turn: number;
  lines: string[];
}

export interface ResultsExtras {
  diagnostics?: string;
  /** poznámky od uživatele: zamítnuté změny, odpověď na ask… */
  userNotes?: string[];
  /** chyby parsování předchozí odpovědi */
  parseErrors?: string[];
}

export const DEFAULT_OPTIONS: BuilderOptions = {
  mode: "stateful",
  maxChars: 60000,
  resultMaxChars: 12000,
  language: "cs",
};

/** Zkrátí text na hlavu + patu a přidá poznámku. */
export function truncate(text: string, max: number, fullPath?: string): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const omitted = text.length - head - tail;
  const lines = text.slice(head, text.length - tail).split("\n").length;
  const hint = fullPath ? ` Full output: <read path="${fullPath}"/>.` : "";
  return {
    text: `${text.slice(0, head)}\n… (truncated: ${omitted} chars / ~${lines} lines omitted.${hint})\n${text.slice(text.length - tail)}`,
    truncated: true,
  };
}

/** Nad tuto délku se výstup úspěšného příkazu posílá jen jako konec (začátek je k dispozici v souboru). */
export const OK_RUN_OUTPUT_MAX = 4000;

/**
 * Úspěšný příkaz (exit 0) s dlouhým výstupem: model zpravidla potřebuje jen závěr
 * (souhrn testů, poslední řádky buildu). Necháme konec, začátek jen shrneme.
 */
export function compactOkOutput(text: string, fullPath?: string): string {
  if (text.length <= OK_RUN_OUTPUT_MAX) return text;
  const tailText = text.slice(text.length - OK_RUN_OUTPUT_MAX);
  const cut = tailText.indexOf("\n");
  const tail = cut >= 0 ? tailText.slice(cut + 1) : tailText;
  const omittedLines = text.slice(0, text.length - tail.length).split("\n").length - 1;
  const hint = fullPath ? ` Full output: <read path="${fullPath}"/>.` : "";
  return `… (exit 0; first ${omittedLines} lines omitted, showing the end.${hint})\n${tail}`;
}

function escapeAttr(v: string): string {
  return v.replace(/"/g, "&quot;").replace(/\n/g, " ");
}

export function buildProtocolSpec(): string {
  const lines: string[] = [];
  lines.push("## Protocol");
  lines.push("");
  lines.push(
    "You cannot call tools directly. Instead, every reply MUST contain exactly one block:",
    "",
    '<whisper turn="N">',
    "  ...actions...",
    "</whisper>",
    "",
    "where N is the turn number given in the prompt you are answering. Text outside the block is ignored",
    "(you may think aloud there, but keep it brief). Inside the block use <think>...</think> for reasoning.",
    "Actions are executed in order; results come back in the next prompt as <whisper-results>.",
    "Body content of <write>, <edit>, <run>, <ask>, <status>, <done> is taken verbatim: no escaping, no code fences.",
    "",
    "## Actions",
    "",
  );
  for (const t of TOOLS) {
    const attrs = t.attrs.map((a) => `${a.name}${a.required ? "" : "?"}: ${a.doc}`).join("; ");
    lines.push(`### <${t.name}${t.hasBody ? ">…</" + t.name + ">" : "/>"}`);
    lines.push(t.doc);
    if (attrs) lines.push(`Attributes: ${attrs}`);
    if (t.bodyDoc) lines.push(`Body: ${t.bodyDoc}`);
    lines.push("Example:");
    lines.push(t.example);
    lines.push("");
  }
  return lines.join("\n");
}

export function buildRules(opts: BuilderOptions): string {
  // každé pravidlo = jeden řetězec s odřádkováním; číslování se doplní až podle toho, která pravidla jsou zapnutá
  const rules: string[] = [
    "EVERY turn costs the user manual copy-paste work. Minimise turns: before changing code, request in ONE\n" +
      "turn all files, searches and listings you will plausibly need (typically 5-15 read/grep/ls actions,\n" +
      "or one <bundle> for a whole module or codebase). Never ask for files one at a time.",
    "Prefer <edit> with small, unique SEARCH blocks over <write> for existing files. Use <write> only for new\nfiles or complete rewrites.",
    "After changing code, verify it in the same turn when possible: add <run> for tests/build and\n" +
      "<diagnostics/> at the end. Fix errors reported back to you. Keep command output small (no verbose\n" +
      "flags); long outputs are truncated. To verify a GUI app visually, start it with <run probe=\"N\" capture=\"M\">\n" +
      "(or use <screenshot/> while it runs): the screenshot is attached as an image to the next prompt.",
    "Do not repeat unchanged file content. Do not explain the protocol back. Do not include the\n<whisper-results> block in your reply.",
    "Use <ask> when the task is ambiguous or a change is risky (deleting data, changing public APIs).",
    "Finish with <done> containing a summary for the user. <done> may come at the END of a block after final\n" +
      "actions (a last edit, a test run) so you do not spend an extra turn; if any of those actions fails, the\n" +
      "task continues and you get the results instead. Nothing may follow <done>.",
    `Write <status>, <ask> and <done> texts in language "${opts.language}"; code and identifiers stay as in the project.`,
    "If a previous action failed, read the error, adjust and retry; do not repeat the identical action.",
  ];
  if (opts.planMode) {
    rules.push(
      "PLAN MODE is ON for this task: your FIRST block must contain <plan> with a hierarchical markdown checklist\n" +
        "(`- [ ] item`, subtasks indented by two spaces). Keep it current in later turns: tick finished items,\n" +
        "add work you discover, split items into subtasks; resend the complete <plan> whenever it changes.",
    );
  } else if (opts.planAuto !== false) {
    rules.push(
      "For larger tasks (several files or distinct steps) start with <plan>: a hierarchical markdown checklist\n" +
        "(`- [ ] item`, subtasks indented by two spaces). Keep it current: tick finished items, add discovered\n" +
        "work, split items; resend the complete <plan> whenever it changes. Small tasks need no plan.",
    );
  }
  if (opts.directDialog !== false) {
    rules.push(
      "DIRECT DIALOGUE: the user reads this chat. When you need to ask something, you may ask directly in the\n" +
        "chat text and wait for the user's answer here (no <whisper> block needed for that message). The user may\n" +
        "also write clarifications directly in the chat. Whenever such an exchange happens, your NEXT <whisper>\n" +
        "block must START with <dialog from=\"model\">the question you asked</dialog> and <dialog from=\"user\">\n" +
        "the user's message, verbatim</dialog> so the agent records it. Prefer <ask options=…> when the answer is\n" +
        "a choice from a few options.",
    );
  }
  if (opts.continuousSuggest) {
    rules.push(
      "When you notice something reusable, add a <suggest> action: a repeated instruction (kind=skill or whisper),\n" +
        "a safe command worth running without confirmation (kind=allow, regex), a check to run automatically after\n" +
        "files change (kind=hook), or a follow-up worth doing later (kind=task). Suggestions are never applied\n" +
        "automatically; keep them rare and concrete.",
    );
  }
  const lines = ["## Rules", ""];
  rules.forEach((r, i) => {
    const num = `${i + 1}. `;
    const indent = " ".repeat(num.length);
    lines.push(num + r.split("\n").join("\n" + indent));
  });
  lines.push("");
  return lines.join("\n");
}

/** Prompt, který požádá model o návrhy skillů/hooků/úkolů z průběhu práce. */
export function buildSuggestPrompt(
  sessionId: string,
  turn: number,
  transcript: string,
  ctx: ProjectContext,
  opts: BuilderOptions,
  history: SuggestionHistory = { approved: [], rejected: [] },
): string {
  const existing: string[] = [];
  const ex = ctx.existing ?? {};
  if (ctx.rules?.length) existing.push(`- rules already in the preamble: ${ctx.rules.length} (listed above under "Additional rules")`);
  if (ctx.skills?.length) existing.push(`- skills: ${ctx.skills.map((s) => "/" + s.name).join(", ")}`);
  if (ex.hooks?.length) existing.push(`- hooks: ${ex.hooks.join("; ")}`);
  if (ex.allowPatterns?.length) existing.push(`- allow patterns (regex): ${ex.allowPatterns.join(" , ")}`);
  if (ex.autoAllow?.length) existing.push(`- commands allowed by prefix: ${ex.autoAllow.join(", ")}`);
  if (ex.planOpen?.length) existing.push(`- open plan tasks: ${ex.planOpen.slice(0, 20).join(" | ")}`);
  if (ex.settings && Object.keys(ex.settings).length) existing.push(`- settings: ${JSON.stringify(ex.settings)}`);
  if (history.approved.length) existing.push(`- suggestions the user already APPROVED earlier: ${history.approved.slice(-30).join(" | ")}`);
  if (history.rejected.length) existing.push(`- suggestions the user REJECTED earlier (do not propose again): ${history.rejected.slice(-30).join(" | ")}`);
  for (const s of ex.skillBodies ?? []) {
    const body = s.body.length > 700 ? s.body.slice(0, 700) + " …" : s.body;
    existing.push(`- skill /${s.name} (current content, improve it with update="${s.name}" instead of adding a similar skill):\n  ${body.replace(/\n/g, "\n  ")}`);
  }
  return [
    buildPreamble(ctx, opts),
    "## Already configured (check before proposing; never duplicate or rephrase these)",
    "",
    ...(existing.length ? existing : ["- nothing yet"]),
    "",
    "## Work history to analyse",
    "",
    transcript.trim(),
    "",
    "## Task",
    "",
    "Analyse the work history above and propose improvements for the user to approve or reject. Use ONLY",
    "<status> and <suggest> actions, then <done>. Look at TWO levels:",
    "",
    "A) This project (scope=\"project\"): skill (reusable instructions the user can invoke with /name; body starts",
    "   with `# name` and a one-line description), script (a REAL runnable script, see AUTOMATION below),",
    "   whisper (lines for WHISPER.md: conventions, commands, pitfalls",
    "   seen here), hook (JSON {\"match\": glob, \"run\": command, \"cwd\"?: dir} run automatically after matching",
    "   files change, e.g. lint or tests), allow (regex for commands that proved safe here), task (follow-up work",
    "   discovered but not done).",
    "",
    "B) The agent itself, in EVERY project (scope=\"global\"): this matters most. Look for wasted turns, repeated",
    "   mistakes, misread results, actions that failed and had to be retried, missing verification, awkward",
    "   protocol usage. Propose: rule (one concise behavioural rule that would have prevented the problem, added",
    "   to the agent's preamble everywhere), setting (JSON {\"key\": \"whisper.…\", \"value\": …}, e.g. prompt limits or",
    "   plan/approval behaviour), allow (regex for commands safe in any project, e.g. read-only git/npm commands),",
    "   skill or whisper with scope=global for instructions useful everywhere, agent (feedback for the developer of",
    "   the agent: protocol, tools, prompts or UI that hindered you; cannot be applied automatically).",
    "",
    "AUTOMATION (do not skip this): do not propose only wording. Go through the history and find work that was",
    "done BY HAND and will repeat: multi-step command sequences, manual checks before a commit or release, data",
    "or file transformations done in several steps, repeated edits of the same shape, verification that needed",
    "several commands in a row, anything the user had to repeat across turns. For each such job propose",
    "<suggest kind=\"script\" lang=\"python|node|bash|powershell\" file=\"name.ext\" title=\"…\"> whose BODY IS THE",
    "COMPLETE SOURCE of a script that does the whole job in one run: real code, no placeholders, no TODOs,",
    "arguments and paths handled, failures reported with a non-zero exit code, and a short usage comment at the",
    "top. It is saved to .whisper/scripts/ and can then be run with <run>. Prefer a script over a rule whenever",
    "the job is mechanical; a rule only tells the agent to be careful, a script does the work every time.",
    "A hook is for something that must run automatically after files change; a script is for a job invoked when",
    "it is needed. When a script would be useful in every project (release checks, log analysis, project",
    "scaffolding), propose it with scope=\"global\".",
    "",
    "BEFORE each suggestion check the \"Already configured\" section and the preamble: if an equivalent rule, hook,",
    "pattern, skill, setting or task already exists (even worded differently), or the user rejected it earlier, do",
    "NOT propose it; propose only what is missing. If the problem is better solved by IMPROVING an existing item,",
    "propose that instead of a new one: <suggest kind=\"skill\" update=\"name\"> with the complete new skill text,",
    "<suggest kind=\"rule\" update=\"rule N\"> with the replacement wording of rule N from \"Additional rules\", or",
    "<suggest kind=\"hook\" update=\"<match glob>\"> with the replacement hook JSON. Propose at most 10 suggestions,",
    "each concrete and justified by the history (say which turn or event motivates it). If nothing is worth",
    "suggesting, say so in <done>.",
    "",
    `Session: ${sessionId}. Reply with <whisper turn="${turn}">.`,
  ].join("\n");
}

export function buildPreamble(ctx: ProjectContext, opts: BuilderOptions): string {
  const parts: string[] = [];
  parts.push(`# Whisper Agent session — project "${ctx.workspaceName}"`);
  parts.push("");
  parts.push(
    "You are a coding agent working inside the user's VS Code workspace. A local extension executes the actions",
    "you request and returns their results. Work autonomously like an experienced engineer: explore, change, verify.",
    "",
  );
  parts.push(buildProtocolSpec());
  parts.push(buildRules(opts));
  if (ctx.rules?.length) {
    parts.push("## Additional rules (learned from previous work; follow them)", "");
    ctx.rules.forEach((r, i) => parts.push(`${i + 1}. ${r}`));
    parts.push("");
  }
  if (ctx.globalInstructions?.trim()) {
    parts.push("## User instructions (apply in every project)", "", ctx.globalInstructions.trim(), "");
  }
  if (ctx.instructions?.trim()) {
    parts.push("## Project instructions (WHISPER.md)", "", ctx.instructions.trim(), "");
  }
  return parts.join("\n");
}

export function buildContext(ctx: ProjectContext): string {
  const parts: string[] = ["## Project tree", "", ctx.tree.trim(), ""];
  if (ctx.active) {
    parts.push(`## Active editor: ${ctx.active.path}${ctx.active.selectionRange ? ` (selection ${ctx.active.selectionRange})` : ""}`);
    if (ctx.active.selection) parts.push("", ctx.active.selection, "");
    parts.push("");
  }
  if (ctx.diagnostics?.trim()) {
    parts.push("## Current diagnostics", "", ctx.diagnostics.trim(), "");
  }
  if (ctx.plan?.trim()) {
    parts.push("## Current plan (maintain it with <plan>)", "", ctx.plan.trim(), "");
  }
  if (ctx.skills?.length) {
    parts.push("## Available skills (the user invokes them with /name; their instructions are included in the task when used)", "");
    for (const s of ctx.skills) parts.push(`- /${s.name}: ${s.description}`);
    parts.push("");
  }
  return parts.join("\n");
}

export function buildInitialPrompt(sessionId: string, task: string, ctx: ProjectContext, opts: BuilderOptions): string {
  return [
    buildPreamble(ctx, opts),
    buildContext(ctx),
    "## Task",
    "",
    task.trim(),
    "",
    `Session: ${sessionId}. Reply with <whisper turn="1">.`,
  ].join("\n");
}

export function renderResult(r: ActionResult, opts: BuilderOptions): string {
  const attrs = Object.entries(r.attrs)
    .filter(([k]) => k !== "end")
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join("");
  const meta = Object.entries(r.meta ?? {})
    .map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
    .join("");
  const attached = r.attachments?.length ? ` attached="${r.attachments.map((a) => a.split("/").pop()).join(",")}"` : "";
  const head = `<result of="${r.tool}"${attrs} status="${r.status}"${meta}${attached}`;
  if (!r.output?.trim()) return `${head}/>`;
  const body = r.output.replace(/\r\n/g, "\n");
  // obsah souboru nikdy neusekávat uprostřed (délku hlídá pravidlo 400 řádků a rozpočet promptu)
  const text =
    r.tool === "read" ? body : r.tool === "run" && r.status === "ok" ? compactOkOutput(body, r.fullOutputPath) : truncate(body, opts.resultMaxChars, r.fullOutputPath).text;
  return `${head}>\n${text}\n</result>`;
}

export function buildResultsPrompt(
  sessionId: string,
  turn: number,
  results: ActionResult[],
  extras: ResultsExtras,
  opts: BuilderOptions,
  history: TurnSummary[] = [],
  preambleForStateless?: string,
): string {
  const parts: string[] = [];
  if (opts.mode === "stateless" && preambleForStateless) {
    parts.push(preambleForStateless, "## History so far", "");
    for (const h of history) parts.push(`Turn ${h.turn}:`, ...h.lines.map((l) => `  - ${l}`));
    parts.push("");
  }
  parts.push(`<whisper-results turn="${turn - 1}" session="${sessionId}">`);
  for (const e of extras.parseErrors ?? []) parts.push(`<protocol-error>${e}</protocol-error>`);
  const tail: string[] = [];
  if (extras.diagnostics?.trim()) tail.push(`<diagnostics>\n${extras.diagnostics.trim()}\n</diagnostics>`);
  for (const n of extras.userNotes ?? []) tail.push(`<user>${n.trim()}</user>`);
  tail.push(`Continue. Reply with <whisper turn="${turn}">.`);
  tail.push("</whisper-results>");

  // Rozpočet na výsledky: co se nevejde, neusekneme (to by zničilo obsah souborů),
  // ale označíme jako deferred a model si to vyžádá znovu.
  const fixed = parts.join("\n").length + tail.join("\n").length + 400;
  let budget = opts.maxChars - fixed;
  let deferred = 0;
  for (const r of results) {
    const text = renderResult(r, opts);
    if (text.length + 1 <= budget) {
      parts.push(text);
      budget -= text.length + 1;
    } else {
      deferred++;
      parts.push(renderResult({ ...r, output: undefined, fullOutputPath: undefined, status: "skipped", meta: { deferred: "prompt size limit" } }, opts));
    }
  }
  if (deferred) {
    tail.unshift(
      `<note>${deferred} result(s) above are marked deferred="prompt size limit": they were executed, but their output did not fit into this prompt (limit ${opts.maxChars} chars). Request them again next turn, fewer at a time and with lines="A-B" for big files, or continue without them.</note>`,
    );
  }
  const attachments = results.flatMap((r) => r.attachments ?? []);
  const images = attachments.filter((a) => !/\.(txt|md)$/i.test(a));
  const bundles = attachments.filter((a) => /\.(txt|md)$/i.test(a));
  if (images.length) {
    tail.unshift(
      `<note>Images attached to this message: ${images.map((a) => a.split("/").pop()).join(", ")} (screenshots taken by the actions above). Look at them to verify the GUI. If you cannot see any image, tell the user to attach the files from .whisper/shots/.</note>`,
    );
  }
  if (bundles.length) {
    tail.unshift(
      `<note>Bundle(s) attached to this message: ${bundles.map((a) => a.split("/").pop()).join(", ")} (structured text with numbered lines, one section per file). They may arrive as a pasted text, a text attachment or a file. Use them instead of reading those files again. If you cannot see any bundle, ask the user to paste it from the clipboard history (Win+V) or attach the file from .whisper/out/.</note>`,
    );
  }
  parts.push(...tail);
  let text = parts.join("\n");
  if (text.length > opts.maxChars) {
    // poslední záchrana (obří diagnostika apod.)
    text = truncate(text, opts.maxChars).text;
  }
  return text;
}

export function buildCorrectionPrompt(sessionId: string, turn: number, errors: string[]): string {
  return [
    `<whisper-results turn="${turn}" session="${sessionId}" correction="true">`,
    ...errors.map((e) => `<protocol-error>${e}</protocol-error>`),
    "Your previous reply could not be executed. Send it again, fixed, as a single",
    `<whisper turn="${turn}"> ... </whisper> block. Remember: bodies are verbatim, every <write>/<edit>/<run> needs its closing tag.`,
    "</whisper-results>",
  ].join("\n");
}

export function buildResumePrompt(
  sessionId: string,
  task: string,
  turn: number,
  ctx: ProjectContext,
  history: TurnSummary[],
  opts: BuilderOptions,
): string {
  const parts: string[] = [buildPreamble(ctx, opts), buildContext(ctx), "## Task", "", task.trim(), ""];
  parts.push("## What has happened so far (this is a resumed session; the previous chat context is gone)", "");
  for (const h of history) parts.push(`Turn ${h.turn}:`, ...h.lines.map((l) => `  - ${l}`));
  parts.push("", `Session: ${sessionId}. Continue the task. Reply with <whisper turn="${turn}">.`);
  return parts.join("\n");
}

/** Jednořádkové shrnutí výsledků kola pro historii (stateless / resume). */
export function summarizeTurn(turn: number, results: ActionResult[], statusNote?: string): TurnSummary {
  const lines = results.map((r) => {
    const target = r.attrs.path ?? r.attrs.pattern ?? (r.tool === "run" ? (r.meta?.command ?? "") : "");
    const meta = r.meta ? Object.entries(r.meta).filter(([k]) => k !== "command").map(([k, v]) => `${k}=${v}`).join(" ") : "";
    const first = (r.output ?? "").split("\n").find((l) => l.trim())?.slice(0, 80) ?? "";
    return `${r.tool} ${target} → ${r.status}${meta ? " " + meta : ""}${first && r.status !== "ok" ? ` (${first})` : ""}`.trim();
  });
  if (statusNote) lines.push(`status: ${statusNote}`);
  return { turn, lines };
}
