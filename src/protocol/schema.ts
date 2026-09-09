/**
 * Jediný zdroj pravdy o nástrojích. Z této tabulky se generuje text preambule
 * pro model i validace v parseru a dispatch v ToolRunneru.
 */

export interface ToolAttr {
  name: string;
  required: boolean;
  doc: string;
}

export interface ToolDef {
  name: string;
  attrs: ToolAttr[];
  /** true = párový tag s tělem, false = self-closing */
  hasBody: boolean;
  bodyDoc?: string;
  doc: string;
  example: string;
}

export const TOOLS: ToolDef[] = [
  {
    name: "read",
    hasBody: false,
    attrs: [
      { name: "path", required: true, doc: "workspace-relative path" },
      { name: "lines", required: false, doc: 'line range "A-B" (1-based, inclusive); required for files over ~400 lines' },
    ],
    doc: "Return file contents with line numbers.",
    example: '<read path="src/app.ts" lines="1-120"/>',
  },
  {
    name: "ls",
    hasBody: false,
    attrs: [
      { name: "path", required: false, doc: "directory (default: workspace root)" },
      { name: "depth", required: false, doc: "recursion depth (default 1, max 4)" },
    ],
    doc: "List directory entries (respects .gitignore).",
    example: '<ls path="src" depth="2"/>',
  },
  {
    name: "glob",
    hasBody: false,
    attrs: [{ name: "pattern", required: true, doc: 'glob, e.g. "src/**/*.test.ts"' }],
    doc: "List files matching a glob.",
    example: '<glob pattern="**/*.config.*"/>',
  },
  {
    name: "grep",
    hasBody: false,
    attrs: [
      { name: "pattern", required: true, doc: "regular expression (JS syntax)" },
      { name: "glob", required: false, doc: "restrict to files matching glob" },
      { name: "context", required: false, doc: "lines of context (default 0, max 5)" },
    ],
    doc: "Search file contents. Returns path:line: text.",
    example: '<grep pattern="isValidEmail|validateEmail" glob="src/**/*.ts*"/>',
  },
  {
    name: "write",
    hasBody: true,
    attrs: [
      { name: "path", required: true, doc: "workspace-relative path; parent dirs are created" },
      { name: "end", required: false, doc: "custom end marker if the body itself contains </write>" },
    ],
    bodyDoc: "the complete new file content, verbatim (no escaping, no code fences)",
    doc: "Create or fully overwrite a file. Prefer <edit> for existing files.",
    example:
      '<write path="src/utils/email.ts">\nexport function isValidEmail(v: string) {\n  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(v);\n}\n</write>',
  },
  {
    name: "edit",
    hasBody: true,
    attrs: [{ name: "path", required: true, doc: "existing file" }],
    bodyDoc:
      "one or more SEARCH/REPLACE hunks; SEARCH must match the file text exactly (whitespace-tolerant fallback exists); keep SEARCH short but unique",
    doc: "Modify an existing file with SEARCH/REPLACE hunks.",
    example:
      '<edit path="src/forms/RegisterForm.tsx">\n<<<<<<< SEARCH\n  const canSubmit = name.length > 0;\n=======\n  const canSubmit = name.length > 0 && isValidEmail(email);\n>>>>>>> REPLACE\n</edit>',
  },
  {
    name: "delete",
    hasBody: false,
    attrs: [{ name: "path", required: true, doc: "file to delete" }],
    doc: "Delete a file (user is asked to confirm).",
    example: '<delete path="src/old/legacy.ts"/>',
  },
  {
    name: "run",
    hasBody: true,
    attrs: [
      { name: "cwd", required: false, doc: "working directory relative to workspace (default: root)" },
      { name: "timeout", required: false, doc: "seconds (default 120, max 1800; use 900+ for package installs)" },
      {
        name: "probe",
        required: false,
        doc: "seconds; for GUI apps or servers that never exit: start the command, wait N seconds, report whether it is still running (= started OK) and then stop it",
      },
      {
        name: "capture",
        required: false,
        doc: "seconds (with probe): take a screenshot of the screen this many seconds after start; the image is attached to the next prompt so you can check the GUI",
      },
      { name: "window", required: false, doc: "with capture: part of the window title to capture instead of the whole screen" },
    ],
    bodyDoc: "the shell command",
    doc: "Run a shell command; returns stdout+stderr and exit code. Some commands need user approval. Never run a GUI app or server without probe=, it would block until timeout.",
    example: '<run timeout="180">npm test -- RegisterForm</run>',
  },
  {
    name: "screenshot",
    hasBody: false,
    attrs: [
      { name: "window", required: false, doc: "part of a visible window title; without it the whole screen" },
      { name: "name", required: false, doc: "file name hint" },
    ],
    doc: "Take a screenshot (Windows) and attach it as an image to the next prompt. Use it to verify a GUI app you started with <run probe>; the app must still be running (use capture= on <run> for that).",
    example: '<screenshot window="Spravce ukolu"/>',
  },
  {
    name: "diagnostics",
    hasBody: false,
    attrs: [{ name: "path", required: false, doc: "limit to one file" }],
    doc: "Return current errors/warnings from the editor language servers (TypeScript, ESLint, ...).",
    example: '<diagnostics path="src/forms/RegisterForm.tsx"/>',
  },
  {
    name: "ask",
    hasBody: true,
    attrs: [
      { name: "options", required: false, doc: 'answer choices separated by "|"; shown as buttons (the user may still type a free answer)' },
      { name: "multi", required: false, doc: "true = the user may pick several options" },
    ],
    bodyDoc: "the question for the user",
    doc: "Ask the user a question; the loop pauses until they answer. Use for ambiguous requirements or risky changes. Offer options whenever the answer is a choice.",
    example: '<ask options="Jen v UI|I na serveru|Obojí">Kde má být validace e-mailu?</ask>',
  },
  {
    name: "status",
    hasBody: true,
    attrs: [],
    bodyDoc: "one or two sentences",
    doc: "Short progress note shown to the user.",
    example: "<status>Přidal jsem validaci, teď spouštím testy.</status>",
  },
  {
    name: "dialog",
    hasBody: true,
    attrs: [{ name: "from", required: true, doc: "model = a question you asked directly in the chat; user = what the user wrote directly in the chat (answer, clarification), verbatim" }],
    bodyDoc: "the exact text of the question or of the user's message",
    doc: "Record a direct exchange that happened in the chat outside the protocol, so the agent keeps it in its log and context. Put these first in the block.",
    example: '<dialog from="model">Má být validace i na serveru?</dialog>\n<dialog from="user">Jen v UI, server řešíme jinde.</dialog>',
  },
  {
    name: "plan",
    hasBody: true,
    attrs: [],
    bodyDoc: "the COMPLETE plan as a markdown checklist: `- [ ] task` / `- [x] done task`, subtasks indented by two spaces; always resend the whole plan when it changes",
    doc: "Create or update the task plan (PLAN mode). Use for larger tasks: several files or distinct steps. Keep it current: tick finished items, add discovered work, split items into subtasks.",
    example: "<plan>\n- [x] Prozkoumat stávající validace\n- [ ] Přidat isValidEmail\n  - [ ] utils/email.ts\n  - [ ] testy\n- [ ] Napojit do RegisterForm\n</plan>",
  },
  {
    name: "suggest",
    hasBody: true,
    attrs: [
      { name: "kind", required: true, doc: "skill | whisper | rule | hook | allow | setting | task | agent" },
      { name: "scope", required: false, doc: "project (default) = this workspace only; global = the agent's behaviour in every project" },
      { name: "title", required: true, doc: "short title shown to the user" },
      { name: "update", required: false, doc: 'modify an existing item instead of adding one: skill name, "rule N" (from Additional rules) or a hook match glob; the body is the complete replacement' },
    ],
    bodyDoc:
      "skill: markdown instructions reusable via /name (start with a `# name` line); whisper: lines for the instructions file (WHISPER.md, or the global one); rule: one concise rule for how the agent should work (added to the preamble rules); hook: JSON {\"match\": glob, \"run\": command, \"cwd\"?: dir} run automatically after matching files change; allow: a regular expression for commands that may run without confirmation; setting: JSON {\"key\": \"whisper.…\", \"value\": …}; task: a follow-up task for the plan; agent: feedback for the agent's developer (protocol, tools, prompts) that cannot be applied automatically",
    doc: "Propose a reusable improvement for the user to approve (never applied automatically). Prefer scope=global for anything that would help in every project.",
    example: '<suggest kind="rule" scope="global" title="Testy až po všech editech">Run tests once at the end of a turn, after all edits, not after each file.</suggest>',
  },
  {
    name: "done",
    hasBody: true,
    attrs: [],
    bodyDoc: "final summary: what changed, how it was verified, what remains",
    doc: "Finish the task. Put it last; it may follow final actions in the same block (if one of them fails, the task continues).",
    example: "<done>Přidána validace e-mailu v RegisterForm, testy prochází.</done>",
  },
];

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
export const BODY_TOOLS = new Set(TOOLS.filter((t) => t.hasBody).map((t) => t.name));
export const REQUIRED_ATTRS: Record<string, string[]> = Object.fromEntries(
  TOOLS.map((t) => [t.name, t.attrs.filter((a) => a.required).map((a) => a.name)]),
);

/** Akce rozpoznaná v odpovědi modelu. */
export interface Action {
  tool: string;
  attrs: Record<string, string>;
  body?: string;
  /** pořadí v rámci bloku (pro párování výsledků) */
  index: number;
}

/** Výsledek vykonání akce. */
export interface ActionResult {
  tool: string;
  attrs: Record<string, string>;
  status: "ok" | "error" | "denied" | "skipped";
  /** hlavní textový obsah (výpis souboru, výstup příkazu…) */
  output?: string;
  /** krátké doplňující atributy (exit, bytes, hunks…) */
  meta?: Record<string, string | number>;
  /** cesta k plnému výstupu, pokud byl zkrácen */
  fullOutputPath?: string;
  /** soubory (obrázky) k přiložení k dalšímu promptu, relativní cesty */
  attachments?: string[];
}

export interface ParsedReply {
  turn: number | null;
  session: string | null;
  actions: Action[];
  /** chyby parsování, které se modelu vrátí k opravě */
  errors: string[];
  /** prosté vyjádření mimo blok (uložíme do logu) */
  prose: string;
}
