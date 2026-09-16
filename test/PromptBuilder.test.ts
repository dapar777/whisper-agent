import { describe, expect, it } from "vitest";
import {
  buildCorrectionPrompt,
  buildInitialPrompt,
  buildResultsPrompt,
  DEFAULT_OPTIONS,
  summarizeTurn,
  truncate,
} from "../src/protocol/PromptBuilder";
import { ActionResult } from "../src/protocol/schema";
import { parseReply } from "../src/protocol/ResponseParser";

const ctx = { workspaceName: "demo", tree: "src/\n  a.ts\n", instructions: "Run tests with npm test." };

describe("buildInitialPrompt", () => {
  it("contains protocol, rules, instructions, tree and task", () => {
    const p = buildInitialPrompt("s1", "Add email validation", ctx, DEFAULT_OPTIONS);
    expect(p).toContain("## Protocol");
    expect(p).toContain("### <edit>…</edit>");
    expect(p).toContain("Run tests with npm test.");
    expect(p).toContain("src/\n  a.ts");
    expect(p).toContain("Add email validation");
    expect(p).toContain('Odpověď mi prosím dej v bloku <whisper turn="1">');
  });

  it("examples in the preamble are themselves parseable", () => {
    const p = buildInitialPrompt("s1", "t", ctx, DEFAULT_OPTIONS);
    const examples = p.match(/^<(read|ls|glob|grep|write|edit|delete|run|diagnostics|ask|status|done)\b[\s\S]*?(\/>|<\/\1>)$/gm) ?? [];
    expect(examples.length).toBeGreaterThanOrEqual(10);
    const parsed = parseReply(`<whisper turn="1">\n${examples.join("\n")}\n</whisper>`);
    expect(parsed.errors).toEqual([]);
    expect(parsed.actions).toHaveLength(examples.length);
  });

  it("in file mode asks for a downloadable whisper-reply-N.xml and allows CDATA in it", () => {
    const opts = { ...DEFAULT_OPTIONS, replyMode: "file" as const };
    const p = buildInitialPrompt("s1", "Oprav test.", ctx, opts);
    expect(p).toContain("You attach your reply as a downloadable file");
    expect(p).toMatch(/REPLY AS A FILE: deliver every reply as a downloadable file named whisper-reply-N.xml/);
    expect(p).toContain("may wrap a body in <![CDATA[ … ]]> to keep the file well-formed");
    expect(p).toContain("Odpověď mi prosím dej jako soubor ke stažení whisper-reply-1.xml");
    const next = buildResultsPrompt("s1", 2, [], {}, opts);
    expect(next).toContain("Odpověď mi prosím dej jako soubor ke stažení whisper-reply-2.xml");
    // režim schránky: bez zmínky o souboru, CDATA zakázané
    const clip = buildInitialPrompt("s1", "Oprav test.", ctx, DEFAULT_OPTIONS);
    expect(clip).not.toContain("whisper-reply-");
    expect(clip).toContain("no <![CDATA[ … ]]> wrapper");
  });

  it("frames the tool as the user's copy-paste, never as a capability of the model", () => {
    const p = buildInitialPrompt("s1", "t", ctx, DEFAULT_OPTIONS);
    expect(p).toContain("copies your ENTIRE reply into a");
    expect(p).toContain("You need no plugin, file access or integration for this: the program does the file work, you\nwrite the requests.");
    expect(p).not.toMatch(/connected to the user's VS Code/);
    expect(p).toMatch(/do it in one sentence; it changes nothing, the block is still\nwhat the program needs/);
    expect(p).toMatch(/Prose that explains what the user should change, or code\nin a ``` fence outside the block, is lost/);
    expect(p).toContain("do not escape < as &lt;");
  });

  it("ends a document task with the concrete <write> shape of the expected reply", () => {
    const p = buildInitialPrompt("s1", "Napiš návrh do docs/navrh-x.md se sekcemi Cíle a Rizika.", ctx, DEFAULT_OPTIONS);
    expect(p.trimEnd().endsWith('<write path="docs/navrh-x.md">\n…celý dokument…\n</write>\n<done>krátké shrnutí</done>\n</whisper>')).toBe(true);
    // úloha bez dokumentu: kostra průzkumného kola, ne <write>
    const plain = buildInitialPrompt("s1", "Oprav test.", ctx, DEFAULT_OPTIONS);
    expect(plain).toMatch(/První krok je obvykle vyžádat si vše, co potřebuješ vidět, např\.:\n<whisper turn="1">\n<read path="cesta\/k\/souboru"\/>/);
    expect(plain).not.toContain("Výstupem tohoto zadání je soubor");
    expect(plain.slice(-700)).not.toContain("<write path=");
    const en = buildInitialPrompt("s1", "Write docs/plan.md.", ctx, { ...DEFAULT_OPTIONS, language: "en" });
    expect(en).toMatch(/The output of this task is the file docs\/plan.md, not chat text\. Write the document once, inside the block[^\n]*\n<whisper turn="1">\n<write path="docs\/plan.md">/);
    // v dalších kolech už žádná kostra, jen připomínka
    const next = buildResultsPrompt("s1", 2, [], {}, DEFAULT_OPTIONS);
    expect(next).toMatch(/Pokračuj\. Odpověď mi prosím dej v bloku <whisper turn="2">[^\n]*poznámky napiš až za něj\.\n<\/whisper-results>/);
  });
});

describe("buildResultsPrompt", () => {
  const results: ActionResult[] = [
    { tool: "read", attrs: { path: "src/a.ts" }, status: "ok", output: "1| const a = 1;" },
    { tool: "edit", attrs: { path: "src/b.ts" }, status: "ok", meta: { hunks: "1/1" } },
    { tool: "run", attrs: {}, status: "error", output: "FAIL", meta: { exit: 1, command: "npm test" } },
  ];

  it("renders results, diagnostics and user notes in stateful mode", () => {
    const p = buildResultsPrompt("s1", 3, results, { diagnostics: "a.ts:1:1 error x", userNotes: ["rejected edit"] }, DEFAULT_OPTIONS);
    expect(p.startsWith('<whisper-results turn="2" session="s1">')).toBe(true);
    expect(p).toContain('<result of="read" path="src/a.ts" status="ok">\n1| const a = 1;\n</result>');
    expect(p).toContain('<result of="edit" path="src/b.ts" status="ok" hunks="1/1"/>');
    expect(p).toContain('exit="1"');
    expect(p).toContain("<diagnostics>\na.ts:1:1 error x\n</diagnostics>");
    expect(p).toContain("<user>rejected edit</user>");
    expect(p).toContain('Pokračuj. Odpověď mi prosím dej v bloku <whisper turn="3">');
    expect(p).not.toContain("## Protocol");
  });

  it("includes preamble and history in stateless mode", () => {
    const opts = { ...DEFAULT_OPTIONS, mode: "stateless" as const };
    const p = buildResultsPrompt("s1", 3, results, {}, opts, [summarizeTurn(1, results)], "PREAMBLE");
    expect(p.startsWith("PREAMBLE")).toBe(true);
    expect(p).toContain("Turn 1:");
    expect(p).toContain("run npm test → error exit=1 (FAIL)");
  });

  it("defers whole results instead of cutting the prompt in the middle", () => {
    const big = (name: string): ActionResult => ({ tool: "read", attrs: { path: name }, status: "ok", output: "x".repeat(5000) });
    const opts = { ...DEFAULT_OPTIONS, maxChars: 8000, resultMaxChars: 6000 };
    const p = buildResultsPrompt("s1", 2, [big("a.ts"), big("b.ts"), big("c.ts")], {}, opts);
    expect(p.length).toBeLessThanOrEqual(8000);
    expect(p).toContain('<result of="read" path="a.ts" status="ok">');
    expect(p).toContain('<result of="read" path="b.ts" status="skipped" deferred="prompt size limit"/>');
    expect(p).toContain('<result of="read" path="c.ts" status="skipped" deferred="prompt size limit"/>');
    expect(p).toContain("2 result(s) above are marked deferred");
    expect(p).not.toContain("… (truncated");
  });

  it("never cuts file contents of <read> in the middle, only other outputs", () => {
    const long = Array.from({ length: 400 }, (_, i) => `${i + 1}| line ${i}`).join("\n");
    const opts = { ...DEFAULT_OPTIONS, resultMaxChars: 500 };
    const read = buildResultsPrompt("s1", 2, [{ tool: "read", attrs: { path: "a.ts" }, status: "ok", output: long }], {}, opts);
    expect(read).not.toContain("… (truncated");
    expect(read).toContain("400| line 399");
    const failed = buildResultsPrompt("s1", 2, [{ tool: "run", attrs: {}, status: "error", output: long }], {}, opts);
    expect(failed).toContain("… (truncated");
    expect(failed).toContain("1| line 0");
    expect(failed).toContain("400| line 399");
  });

  it("keeps only the end of a long output of a successful command", () => {
    const long = Array.from({ length: 600 }, (_, i) => `ok ${i} - some test name`).join("\n");
    const run = buildResultsPrompt("s1", 2, [{ tool: "run", attrs: {}, status: "ok", output: long, fullOutputPath: ".whisper/out/run.txt" }], {}, DEFAULT_OPTIONS);
    expect(run).toContain("(exit 0; first");
    expect(run).toContain("lines omitted, showing the end");
    expect(run).toContain('<read path=".whisper/out/run.txt"/>');
    expect(run).toContain("ok 599 - some test name");
    expect(run).not.toContain("ok 0 - some test name");
    // krátký výstup zůstává celý
    const short = buildResultsPrompt("s1", 2, [{ tool: "run", attrs: {}, status: "ok", output: "ok 1\nok 2" }], {}, DEFAULT_OPTIONS);
    expect(short).toContain("ok 1\nok 2");
  });

  it("truncates long outputs with head and tail", () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const t = truncate(long, 400, ".whisper/out/run-1.txt");
    expect(t.truncated).toBe(true);
    expect(t.text.length).toBeLessThan(600);
    expect(t.text).toContain("line 0");
    expect(t.text).toContain("line 499");
    expect(t.text).toContain('<read path=".whisper/out/run-1.txt"/>');
  });
});

describe("buildCorrectionPrompt", () => {
  it("lists protocol errors", () => {
    const p = buildCorrectionPrompt("s1", 2, ["Missing closing </write>"]);
    expect(p).toContain("<protocol-error>Missing closing </write></protocol-error>");
    expect(p).toContain('<whisper turn="2">');
  });
});
