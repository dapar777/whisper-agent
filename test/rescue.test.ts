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
    expect(step.prompt).toMatch(/saved your text as docs\/navrh-ical.md/);
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
