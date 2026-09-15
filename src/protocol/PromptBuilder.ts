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
  /** jak silně pobízet model k <bundle> místo mnoha <read> */
  bundleUsage?: BundleUsage;
  /** první <done> po změnách souborů vyvolá revizi (svazek změněných souborů), finální je <done reviewed="true"> */
  reviewBeforeDone?: boolean;
}

/** Stupně používání hromadných txt svazků (<bundle>). */
export type BundleUsage = "off" | "allow" | "encourage" | "prefer" | "always";

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
  /** obsah souborů, na které uživatel odkázal přes #soubor (blok už hotový) */
  refs?: string;
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
  /** poznámky agenta modelu (co sám opravil nebo udělal za něj) */
  agentNotes?: string[];
  /** dokument ze zadání, který ještě neexistuje: připomínka ukáže tvar odpovědi s <write> */
  docTarget?: string;
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

/** Cesta dokumentu (.md/.txt) zmíněná v zadání, pokud nějaká je. */
export function documentPathInTask(task: string): string | undefined {
  return task.match(/(?:^|[\s"'`(])((?:[\w.-]+\/)*[\w.-]+\.(?:md|markdown|txt))(?=$|[\s"'`),.;:])/)?.[1];
}

/** Volby připomínky formátu na konci promptu. */
export interface ReminderOptions {
  /** dokument ze zadání, který ještě neexistuje: připomínka ukáže kostru s <write> */
  docTarget?: string;
  language?: string;
  /** první prompt úlohy: u úloh bez dokumentu ukáže kostru průzkumného kola */
  initial?: boolean;
}

export function replyReminder(turn: number, o: ReminderOptions = {}): string {
  // v jazyce uživatele: zadání je v něm také, takže připomínka zní jako součást požadavku uživatele,
  // ne jako „technická omáčka nástroje“, kterou obecné chaty přeskakují
  const cs = (o.language ?? "en").toLowerCase().startsWith("cs");
  // první osoba = hlas uživatele (ne „nástroje“): to je to, co obecné chaty poslouchají
  const base = cs
    ? `Odpověď mi prosím dej v bloku <whisper turn="${turn}"> … </whisper> a samotnou práci dej dovnitř; ` +
      `můj program čte jen ten blok, text mimo něj se zahodí a nikam se neuloží. Nejlépe začni odpověď rovnou blokem a poznámky napiš až za něj.`
    : `Please give me the reply in the block <whisper turn="${turn}"> … </whisper> with the work itself inside it; ` +
      `my program reads only that block, text outside it is discarded and not saved. Best start the reply with the block and put remarks after it.`;
  if (o.docTarget) {
    const d = o.docTarget;
    return cs
      ? `${base} Výstupem tohoto zadání je soubor ${d}, ne text v chatu. Dokument napiš jen jednou, a to uvnitř bloku ` +
          `(ne do chatu s odkazem „viz výše“ v bloku):\n<whisper turn="${turn}">\n<write path="${d}">\n…celý dokument…\n</write>\n<done>krátké shrnutí</done>\n</whisper>`
      : `${base} The output of this task is the file ${d}, not chat text. Write the document once, inside the block ` +
          `(not in the chat with a "see above" pointer in the block):\n<whisper turn="${turn}">\n<write path="${d}">\n…the whole document…\n</write>\n<done>short summary</done>\n</whisper>`;
  }
  if (o.initial) {
    return cs
      ? `${base} První krok je obvykle vyžádat si vše, co potřebuješ vidět, např.:\n<whisper turn="${turn}">\n<read path="cesta/k/souboru"/>\n<read path="další/soubor"/>\n<grep pattern="hledaný_text"/>\n</whisper>\nÚpravy kódu pak přijdou v dalším kole jako <edit>; radu v próze nebo kód v \`\`\` mimo blok můj program nepoužije a já ho nebudu přepisovat ručně.`
      : `${base} The first step is usually to request everything you need to see, e.g.:\n<whisper turn="${turn}">\n<read path="path/to/file"/>\n<read path="another/file"/>\n<grep pattern="text_to_find"/>\n</whisper>\nCode changes then follow in the next turn as <edit>; advice in prose or code in \`\`\` outside the block is not used by my program and I will not retype it by hand.`;
  }
  return base;
}

/** „Pokračuj.“ v jazyce uživatele (před připomínkou formátu na konci výsledků). */
function continueWord(language = "en"): string {
  return language.toLowerCase().startsWith("cs") ? "Pokračuj." : "Continue.";
}

export function buildProtocolSpec(): string {
  const lines: string[] = [];
  lines.push("## Protocol");
  lines.push("");
  lines.push(
    "Every reply contains exactly one block:",
    "",
    '<whisper turn="N">',
    "  ...actions...",
    "</whisper>",
    "",
    "where N is the turn number given in the prompt you are answering. Text outside the block is welcome but",
    "the tool ignores it, so anything you want done must be an action inside the block. Inside the block use",
    "<think>...</think> for reasoning.",
    "Actions are executed in order; results come back in the next prompt as <whisper-results>.",
    "Body content of <write>, <edit>, <run>, <ask>, <status>, <done> is taken verbatim as plain text: write <, >",
    "and & as plain characters (never &lt; &gt; &amp;), no <![CDATA[ … ]]> wrapper, no code fence around the",
    "body (this is not XML, only tags with bodies).",
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

/**
 * Text do preambule podle stupně `whisper.bundle.usage`. Bez tohoto pobídnutí model
 * <bundle> skoro nepoužívá a raději posílá desítky jednotlivých <read>.
 */
export function bundleRule(level: BundleUsage): string | undefined {
  switch (level) {
    case "off":
      return "Do NOT use <bundle>; request files with <read> only.";
    case "allow":
      return undefined; // nástroj je popsaný v seznamu akcí, žádné zvláštní pobídnutí
    case "encourage":
      return [
        "When you need to see MORE THAN ABOUT FIVE files, ask for them with a single <bundle> instead of many",
        "<read> actions: one bundle costs the user one paste, five reads cost five results in the next prompt.",
        "Use <read> for one or two files, or when you need only a line range.",
      ].join("\n");
    case "prefer":
      return [
        "PREFER <bundle> over <read>. Whenever you need more than TWO files, or you do not yet know exactly which",
        "files matter, request them in ONE <bundle> (globs and directories are allowed, e.g.",
        '<bundle paths="src/**/*.ts, tests"/>). Getting too much context in one bundle is cheap; discovering a',
        "missing file next turn is expensive. Keep <read> for a single file or a specific line range.",
      ].join("\n");
    case "always":
      return [
        "ALWAYS start a task by pulling the relevant code as ONE bundle: <bundle> with globs covering the modules",
        'you will touch, or <bundle all="true"/> for a small or unfamiliar project. Do this in your FIRST block,',
        "together with your exploration actions. Only after you have the bundle may you use <read>, and only for a",
        "file the bundle did not contain or for a specific line range. Never send more than two <read> actions in",
        "one block when a bundle would cover them.",
      ].join("\n");
  }
}

export function buildRules(opts: BuilderOptions): string {
  // každé pravidlo = jeden řetězec s odřádkováním; číslování se doplní až podle toho, která pravidla jsou zapnutá
  const rules: string[] = [
    "EVERY turn costs the user manual copy-paste work. Minimise turns: before changing code, request in ONE\n" +
      "turn all files, searches and listings you will plausibly need (typically 5-15 read/grep/ls actions,\n" +
      "or one <bundle> for a whole module or codebase). Never ask for files one at a time.",
    "Prefer <edit> with small, unique SEARCH blocks over <write> for existing files. Use <write> only for new\nfiles or complete rewrites.",
    "DOCUMENTS ARE FILES: when the deliverable is a document (proposal, spec, README, any .md/.txt), put its\n" +
      'COMPLETE text inside <write path="docs/name.md"> in the block, never as chat text: text outside the block is\n' +
      "discarded and the file would not exist. The body is verbatim: no HTML escaping, no outer ``` fence; it may\n" +
      "freely contain code fences, tables, <whisper> examples, SEARCH markers or </write>. To revise an existing\n" +
      'document, read it (or take a <bundle>), then replace whole sections with <edit path="…" section="## Heading">\n' +
      "or change sentences with small SEARCH/REPLACE hunks; retype the whole document only for a full rewrite.",
    "After changing code, verify it in the same turn when possible: add <run> for tests/build and\n" +
      "<diagnostics/> at the end. Fix errors reported back to you. LEAVE EVERY FILE VALID: the tool checks each\n" +
      "file you write or edit for syntax errors and for protocol residue (CDATA, &lt; entities, SEARCH markers,\n" +
      "fences, stray tags) and reports problems in the result; such a file counts as a failed action, so <done>\n" +
      "is refused until you fix it with small <edit> hunks. Keep command output small (no verbose\n" +
      "flags); long outputs are truncated. To verify a GUI app visually, start it with <run probe=\"N\" capture=\"M\">\n" +
      "(or use <screenshot/> while it runs): the screenshot is attached as an image to the next prompt.",
    "Do not repeat unchanged file content. Do not explain the protocol back. Do not include the\n<whisper-results> block in your reply.",
    "Use <ask> when the task is ambiguous or a change is risky (deleting data, changing public APIs).",
    "Finish with <done> containing a summary for the user. <done> may come at the END of a block after final\n" +
      "actions (a last edit, a test run) so you do not spend an extra turn; if any of those actions fails, the\n" +
      "task continues and you get the results instead. Nothing may follow <done>." +
      (opts.reviewBeforeDone === false
        ? ""
        : "\nREVIEW BEFORE DONE: when files were changed, the first <done> is not final. The tool replies with a review\n" +
          "request and a bundle holding the complete current content of every changed file. Review the whole work\n" +
          "against the task (other files, tests, docs too; several turns if needed), fix what is missing with <edit>,\n" +
          'and finish with <done reviewed="true">. Any further file change triggers one more review of the changes.'),
    `Write <status>, <ask> and <done> texts in language "${opts.language}"; code and identifiers stay as in the project.`,
    "If a previous action failed, read the error, adjust and retry; do not repeat the identical action.",
  ];
  const bundle = bundleRule(opts.bundleUsage ?? "encourage");
  if (bundle) rules.splice(1, 0, bundle);
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
      "DIRECT DIALOGUE: the user reads this chat and may answer or clarify right here in plain text. Ask your\n" +
        "questions with <ask options=…> inside the block (you may repeat the question in plain words around it);\n" +
        "the block is still required in that reply. When the user then writes to you directly in the chat, your\n" +
        "NEXT block must START with <dialog from=\"user\">the user's message, verbatim</dialog> (and\n" +
        "<dialog from=\"model\">your question</dialog> if you asked it only in plain text) so the tool records it.",
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
    `Session: ${sessionId}. ${replyReminder(turn, { language: opts.language })}`,
  ].join("\n");
}

export function buildPreamble(ctx: ProjectContext, opts: BuilderOptions): string {
  const parts: string[] = [];
  parts.push(`# Whisper Agent session — project "${ctx.workspaceName}"`);
  parts.push("");
  parts.push(
    "How this works: your reply is not read by a person first. The user copies your ENTIRE reply into a",
    "small program on their own computer, and that program looks for ONE block in your text,",
    "",
    '<whisper turn="N">',
    "  ...actions...",
    "</whisper>",
    "",
    "and carries out the requests written in it: it reads, searches, writes and edits the user's files and",
    "runs commands (the user reviews every change), then the user pastes the results back here as the next",
    "message. You need no plugin, file access or integration for this: the program does the file work, you",
    "write the requests. Work like an experienced engineer dictating to an assistant: explore, change,",
    "verify.",
    "",
    "ONLY THE BLOCK COUNTS. Everything outside it is thrown away: never saved, never executed, never",
    "applied. A short remark outside the block does no harm, but the work itself must be INSIDE it: a",
    'document inside a write action (<write path="…">…</write>), a code change inside <edit>…</edit>, a',
    "question inside an ask action (<ask>…</ask>). Prose that explains what the user should change, or code",
    "in a ``` fence outside the block, is lost: the user has to come back and ask again. If you want to point",
    "out that you cannot access files yourself, do it in one sentence; it changes nothing, the block is still",
    "what the program needs. Do not wrap the block in a ``` fence and do not escape < as &lt;.",
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
  if (ctx.refs?.trim()) {
    parts.push(ctx.refs.trim(), "");
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
    `Session: ${sessionId}. ${replyReminder(1, { docTarget: documentPathInTask(task), language: opts.language, initial: true })}`,
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
  for (const n of extras.agentNotes ?? []) tail.push(`<note>${n.trim()}</note>`);
  for (const n of extras.userNotes ?? []) tail.push(`<user>${n.trim()}</user>`);
  tail.push(`${continueWord(opts.language)} ${replyReminder(turn, { docTarget: extras.docTarget, language: opts.language })}`);
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

export interface CorrectionContext {
  /** zadání úkolu (zkrácené), aby model věděl, kam má dokument zapsat */
  task?: string;
  /** odpověď bez bloku: jak vypadala (dokument / otázka / jiné) */
  prose?: string;
  /** kolikátý pokus o opravu v řadě (1 = první) */
  attempt?: number;
  /** poznámky uživatele napsané během čekání (jinak by se ztratily) */
  userNotes?: string[];
  /** cesta, kam agent prose sám uložil pro pozdější použití */
  savedTo?: string;
  /** preambule pro stateless režim (chat nemá historii) */
  preamble?: string;
  /** dokument z úkolu už existuje: model má editovat, ne posílat celý text znovu */
  existingDoc?: string;
}

/** Hrubý odhad, zda text bez bloku je dokument (nadpisy, odrážky), nebo spíš otázka/komentář. */
export function classifyProse(prose: string): "document" | "question" | "other" {
  const t = prose.trim();
  if (!t) return "other";
  const lines = t.split("\n");
  const structured = lines.filter((l) => /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|\|)/.test(l)).length;
  const lastLines = lines.slice(-3).join(" ");
  if (t.length < 700 && /\?\s*$/.test(lastLines)) return "question";
  if (structured >= 3 && t.length >= 400) return "document";
  if (/\?\s*$/.test(lastLines)) return "question";
  return "other";
}

export function buildCorrectionPrompt(sessionId: string, turn: number, errors: string[], ctx: CorrectionContext = {}): string {
  const attempt = ctx.attempt ?? 1;
  const lines: string[] = [];
  if (ctx.preamble) lines.push(ctx.preamble, "");
  lines.push(`<whisper-results turn="${turn}" session="${sessionId}" correction="true">`);
  for (const e of errors) lines.push(`<protocol-error>${e}</protocol-error>`);
  const kind = ctx.prose ? classifyProse(ctx.prose) : "other";
  if (ctx.prose && kind === "document" && ctx.existingDoc) {
    lines.push(
      `<note>Your reply contained no <whisper> block with actions, so NOTHING was changed: the agent only executes actions inside the block,`,
      `and the document ${ctx.existingDoc} already exists, so do not paste sections into the chat. Apply the changes yourself:`,
      `<whisper turn="${turn}">`,
      `<read path="${ctx.existingDoc}"/>   (only if you have not seen its current text)`,
      `<edit path="${ctx.existingDoc}" section="## Existing heading">…complete new text of that section…</edit>`,
      `<edit path="${ctx.existingDoc}" section="## Neighbour heading" insert="before">## New section\n…its text…</edit>`,
      `<done>…</done>`,
      `</whisper>`,
      `Small wording changes can use SEARCH/REPLACE hunks. Questions go into <ask options="A|B">…</ask> inside the block.` +
        `${ctx.savedTo ? ` Your chat text was saved for reference to ${ctx.savedTo}.` : ""}</note>`,
    );
  } else if (ctx.prose && kind === "document") {
    lines.push(
      "<note>Your reply contained no <whisper> block with actions, so NOTHING was executed and no file was created:",
      "the agent only executes actions inside the block. Your text looks like the document itself. Send it again as",
      `<whisper turn="${turn}">`,
      `<write path="${(ctx.task && documentPathInTask(ctx.task)) ?? "docs/NAME.md"}">`,
      "…the complete document text, verbatim (code fences and examples included)…",
      "</write>",
      "<done>…</done>",
      "</whisper>",
      `${ctx.savedTo ? `The text you wrote was saved for reference to ${ctx.savedTo}. ` : ""}Use the file path the task asks for.</note>`,
    );
  } else if (ctx.prose && kind === "question") {
    lines.push(
      "<note>Your reply contained no <whisper> block. If it was a question for the user, ask it inside the block with",
      '<ask options="A|B">…</ask> (the user then answers here); otherwise continue with actions.</note>',
    );
  } else {
    lines.push(
      "<note>Format requirement of the user's tool: every reply must contain the block, otherwise the tool cannot use",
      `the reply at all. Send it again as a single <whisper turn="${turn}"> ... </whisper> block (text around it is fine).`,
      "Bodies are verbatim, every <write>/<edit>/<run> needs its own closing tag. If you only want to say something or",
      `ask something, that is a block too: <whisper turn="${turn}"><ask options="A|B">…</ask></whisper>.</note>`,
    );
  }
  if (attempt >= 2) {
    lines.push(
      `<note>This is correction attempt ${attempt}. Start your reply with <whisper turn="${turn}"> and end it with </whisper>; put explanations AFTER the block if you need them, and no code fence around the block. The tool reads only the block: without it, the user's work stops here.</note>`,
    );
  }
  if (ctx.task) lines.push(`<task>${ctx.task.trim().slice(0, 600)}</task>`);
  for (const n of ctx.userNotes ?? []) lines.push(`<user>${n.trim()}</user>`);
  lines.push("</whisper-results>");
  return lines.join("\n");
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
  parts.push("", `Session: ${sessionId}. Continue the task. ${replyReminder(turn, { language: opts.language })}`);
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
