import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { NodeHost } from "../src/host/NodeHost";
import { TurnEngine, trimChatter } from "../src/agent/TurnEngine";
import { createSession } from "../src/session/SessionData";

const PROSE = [
  "Certainly! Here is the design proposal you asked for. 🙂",
  "",
  "*Note: I can't run code or access your files directly.*",
  "",
  "---",
  "",
  "# Návrh: export do .ics",
  "",
  "## Cíle",
  "",
  "- a",
  "- b",
  "- c",
  "",
  "## Rizika",
  "",
  "- r1",
  "- r2",
  "",
  "Delší odstavec, aby text vypadal jako skutečný dokument a ne jako pár řádků: " + "lorem ipsum ".repeat(40),
  "",
  "---",
  "",
  "Chcete, abych doplnil i variantu s VEVENT?",
].join("\n");

function engineIn(files: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-rescue-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content, "utf8");
  }
  const host = new NodeHost(root, { autoConfirm: true, log: () => undefined });
  const engine = new TurnEngine(host, { mode: "stateful", maxChars: 60000, resultMaxChars: 12000, language: "cs", treeMaxEntries: 50 });
  return { root, engine };
}

describe("trimChatter", () => {
  it("drops the chat intro before the first heading and the trailing offer/question", () => {
    const t = trimChatter(PROSE);
    expect(t.body.startsWith("# Návrh: export do .ics")).toBe(true);
    expect(t.body.endsWith("lorem ipsum")).toBe(true);
    expect(t.dropped).toHaveLength(2);
    expect(t.dropped[1]).toMatch(/^Chcete/);
  });

  it("leaves a document that has no chatter untouched", () => {
    const doc = "# T\n\n## A\n\n- x\n";
    expect(trimChatter(doc).body).toBe(doc.trim());
  });
});

describe("document rescue for block-less replies", () => {
  it("writes the document to the path named in the task and tells the model what happened", async () => {
    const { root, engine } = engineIn();
    const s = createSession("Napiš návrh jako dokument docs/navrh-ical.md se sekcemi Cíle a Rizika.", "stateful");
    const step = await engine.execute(s, engine.parse(PROSE, 1), 1000);
    expect(step.kind).toBe("next");
    const file = fs.readFileSync(path.join(root, "docs/navrh-ical.md"), "utf8");
    expect(file.startsWith("# Návrh: export do .ics")).toBe(true);
    expect(file).not.toContain("Certainly");
    expect(file).not.toContain("Chcete");
    if (step.kind !== "next") throw new Error("unreachable");
    expect(step.prompt).toContain('<result of="write" path="docs/navrh-ical.md" status="ok"');
    expect(step.prompt).toMatch(/it was saved as docs\/navrh-ical.md/);
    expect(step.prompt).toMatch(/Format requirement: every reply must contain the <whisper> block/);
    expect(step.prompt).toMatch(/put the document inside <write path="docs\/navrh-ical.md">/);
    expect(s.turn).toBe(2);
    expect(s.noBlockReplies).toBe(0);
  });

  it("takes the path from an unfinished <write path> even when the block never closed", async () => {
    const { root, engine } = engineIn();
    const s = createSession("Sepiš to do dokumentu.", "stateful");
    const reply = '```xml\n<whisper turn="1">\n<write path="docs/plan.md">\n# Plan\n\n## Kroky\n\n- 1\n- 2\n- 3\n\n' + "x".repeat(400) + "\n";
    const step = await engine.execute(s, engine.parse(reply, 1), 1000);
    expect(step.kind).toBe("next");
    expect(fs.existsSync(path.join(root, "docs/plan.md"))).toBe(true);
    expect(fs.readFileSync(path.join(root, "docs/plan.md"), "utf8")).not.toContain("<write");
  });

  it("never overwrites an existing document; sends a correction that names the file and counts attempts", async () => {
    const { root, engine } = engineIn({ "docs/navrh-ical.md": "# Puvodni\n" });
    const s = createSession("Vylepši docs/navrh-ical.md.", "stateful");
    const step1 = await engine.execute(s, engine.parse(PROSE, 1), 1000);
    expect(step1.kind).toBe("correction");
    expect(fs.readFileSync(path.join(root, "docs/navrh-ical.md"), "utf8")).toBe("# Puvodni\n");
    if (step1.kind !== "correction") throw new Error("unreachable");
    // dokument existuje: oprava vede k editacím sekcí, ne k novému <write>
    expect(step1.prompt).toMatch(/NOTHING was changed/);
    expect(step1.prompt).toContain('<edit path="docs/navrh-ical.md" section="## Existing heading">');
    expect(step1.prompt).toContain("<task>Vylepši docs/navrh-ical.md.</task>");
    expect(step1.prompt).toContain(".whisper/out/reply-1-1.md");
    expect(fs.existsSync(path.join(root, ".whisper/out/reply-1-1.md"))).toBe(true);
    const step2 = await engine.execute(s, engine.parse(PROSE, 1), 1000);
    if (step2.kind !== "correction") throw new Error("unreachable");
    expect(step2.prompt).toMatch(/correction attempt 2/);
    expect(s.noBlockReplies).toBe(2);
  });

  it("a question without a block gets the <ask> hint, not a document hint", async () => {
    const { engine } = engineIn();
    const s = createSession("Napiš docs/x.md.", "stateful");
    const step = await engine.execute(s, engine.parse("Máte na mysli Python, nebo TypeScript verzi?", 1), 1000, ["moje poznámka"]);
    if (step.kind !== "correction") throw new Error("unreachable");
    expect(step.prompt).toMatch(/<ask options/);
    expect(step.prompt).not.toMatch(/NOTHING was executed/);
    expect(step.prompt).toContain("<user>moje poznámka</user>");
  });
});

describe("block-less prose that names files (advice instead of actions)", () => {
  it("reads the mentioned files so the model gets real data with the format note", async () => {
    const { engine } = engineIn({ "todo/model.py": "x = 1\n", "ts-app/src/model.ts": "export const x = 1;\n" });
    const s = createSession("Doplň sloupec created do exportu.", "stateful");
    const reply =
      "Sure — I can't access files, but here's what to change:\n\n1. In `todo/model.py` add the column.\n2. In `ts-app/src/model.ts` do the same (see todo/model.py).\n\n```python\nHEADER = [...]\n```\n\nCould you paste the contents of todo/model.py and ts-app/src/model.ts?";
    const step = await engine.execute(s, engine.parse(reply, 1), 1000);
    expect(step.kind).toBe("next");
    if (step.kind !== "next") throw new Error("unreachable");
    expect(step.record.actions.map((a) => a.attrs.path)).toEqual(["todo/model.py", "ts-app/src/model.ts"]);
    expect(step.prompt).toContain('<result of="read" path="todo/model.py" status="ok" totalLines="2">\n1| x = 1');
    expect(step.prompt).toMatch(/yours had no block at all, so nothing was applied/);
    expect(step.prompt).toMatch(/the tool read the files your text mentions/);
    expect(s.noBlockReplies).toBe(0);
  });

  it("falls back to the correction when no existing file is mentioned", async () => {
    const { engine } = engineIn();
    const s = createSession("Doplň sloupec created do exportu.", "stateful");
    const step = await engine.execute(s, engine.parse("Sure, change the export function in todo/nope.py to include created.", 1), 1000);
    expect(step.kind).toBe("correction");
  });
});

describe("block with only a remark while the document sits in the chat", () => {
  const CHAT_DOC = PROSE + '\n\n<whisper turn="1"><status>Návrh je výše v chatu.</status><done>Hotovo.</done></whisper>';

  it("rescues the document from outside the block, keeps the remark and drops <done>", async () => {
    const { root, engine } = engineIn();
    const s = createSession("Napiš návrh jako dokument docs/navrh-ical.md.", "stateful");
    const parsed = engine.parse(CHAT_DOC, 1);
    expect(parsed.actions.map((a) => a.tool)).toEqual(["status", "done"]);
    expect(parsed.outside).toContain("# Návrh: export do .ics");
    const step = await engine.execute(s, parsed, 1000);
    expect(step.kind).toBe("next");
    if (step.kind !== "next") throw new Error("unreachable");
    expect(fs.readFileSync(path.join(root, "docs/navrh-ical.md"), "utf8").startsWith("# Návrh: export do .ics")).toBe(true);
    expect(step.record.actions.map((a) => a.tool)).toEqual(["write", "status"]);
    expect(step.prompt).toMatch(/your block held only <status>, <done> while the document was written as chat text outside it/);
    // soubor už existuje: připomínka bez šablony s <write>
    expect(step.prompt).not.toMatch(/Výstupem tohoto zadání je soubor/);
  });

  it('fills a hollow <write> ("copy the text from above") with the document from the chat', async () => {
    const { root, engine } = engineIn();
    const s = createSession("Napiš návrh jako dokument docs/navrh-ical.md.", "stateful");
    const reply =
      PROSE +
      '\n\nA pro ten tvůj nástroj:\n\n```xml\n<whisper turn="1">\n<write path="docs/navrh-ical.md">\nZkopíruj sem text od nadpisu "# Návrh" výše v této zprávě.\n</write>\n<done>Hotovo.</done>\n</whisper>\n```\n';
    const parsed = engine.parse(reply, 1);
    expect(parsed.actions.map((a) => a.tool)).toEqual(["write", "done"]);
    const step = await engine.execute(s, parsed, 1000);
    expect(step.kind).toBe("done");
    const file = fs.readFileSync(path.join(root, "docs/navrh-ical.md"), "utf8");
    expect(file.startsWith("# Návrh: export do .ics")).toBe(true);
    expect(file).not.toContain("Zkopíruj");
    expect(file).not.toContain("```");
    expect(file).not.toContain("A pro ten tvůj nástroj");
  });

  it("leaves a real <write> alone even when the chat repeats the document", async () => {
    const { root, engine } = engineIn();
    const s = createSession("Napiš návrh jako dokument docs/navrh-ical.md.", "stateful");
    const body = "# Jiný nadpis\n\n## Sekce\n\n- 1\n- 2\n- 3\n\n" + "obsah ".repeat(80);
    const reply = PROSE + '\n\n<whisper turn="1">\n<write path="docs/navrh-ical.md">\n' + body + "\n</write>\n<done>Hotovo.</done>\n</whisper>\n";
    const step = await engine.execute(s, engine.parse(reply, 1), 1000);
    expect(step.kind).toBe("done");
    expect(fs.readFileSync(path.join(root, "docs/navrh-ical.md"), "utf8").startsWith("# Jiný nadpis")).toBe(true);
  });

  it("with an existing document it sends the section-edit correction instead of losing the text", async () => {
    const { root, engine } = engineIn({ "docs/navrh-ical.md": "# Puvodni\n" });
    const s = createSession("Vylepši docs/navrh-ical.md.", "stateful");
    const step = await engine.execute(s, engine.parse(CHAT_DOC, 1), 1000);
    expect(step.kind).toBe("correction");
    if (step.kind !== "correction") throw new Error("unreachable");
    expect(step.errors[0]).toMatch(/held only <status>, <done>/);
    expect(step.prompt).toMatch(/NOTHING was changed/);
    expect(fs.readFileSync(path.join(root, "docs/navrh-ical.md"), "utf8")).toBe("# Puvodni\n");
  });

  it("a remark-only block without any document outside runs normally; the reminder shows the <write> shape", async () => {
    const { engine } = engineIn();
    const s = createSession("Napiš docs/x.md.", "stateful");
    const step = await engine.execute(s, engine.parse('Ok.\n<whisper turn="1"><status>Jdu na to.</status></whisper>', 1), 1000);
    expect(step.kind).toBe("next");
    if (step.kind !== "next") throw new Error("unreachable");
    expect(step.prompt).toContain('<write path="docs/x.md">');
    expect(step.prompt).toMatch(/Výstupem tohoto zadání je soubor docs\/x.md, ne text v chatu/);
  });
});
