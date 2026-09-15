import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { NodeHost } from "../src/host/NodeHost";
import { TurnEngine } from "../src/agent/TurnEngine";
import { createSession } from "../src/session/SessionData";
import { buildPreamble } from "../src/protocol/PromptBuilder";

function engineIn(files: Record<string, string>, review = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-review-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content, "utf8");
  }
  const host = new NodeHost(root, { autoConfirm: true, log: () => undefined });
  const engine = new TurnEngine(host, { mode: "stateful", maxChars: 60000, resultMaxChars: 12000, language: "cs", treeMaxEntries: 50, reviewBeforeDone: review });
  return { root, engine };
}

const WRITE_DONE = '<whisper turn="1">\n<write path="src/a.py">\nx = 1\n</write>\n<write path="src/b.py">\ny = 2\n</write>\n<done>Hotovo.</done>\n</whisper>';

describe("review before done", () => {
  it("turns the first <done> after changes into a review round with a bundle of all changed files", async () => {
    const { engine } = engineIn({});
    const s = createSession("Přidej a a b.", "stateful");
    const step = await engine.execute(s, engine.parse(WRITE_DONE, 1), 1000);
    expect(step.kind).toBe("next");
    if (step.kind !== "next") throw new Error("unreachable");
    expect(step.review).toEqual({ round: 1, files: ["src/a.py", "src/b.py"] });
    expect(step.attachments).toEqual([expect.stringMatching(/^\.whisper\/out\/bundle-1-91-/)]);
    expect(step.prompt).toContain('<result of="bundle"');
    expect(step.prompt).toMatch(/REVIEW BEFORE DONE: you sent <done>, but in this session the first <done> after file changes is not final/);
    expect(step.prompt).toMatch(/2: src\/a.py, src\/b.py/);
    expect(step.prompt).toMatch(/finish with <done reviewed="true">/);
    expect(s.changedFiles).toEqual(["src/a.py", "src/b.py"]);
    expect(s.changedSinceReview).toEqual([]);
    expect(s.reviewRounds).toBe(1);

    // revize bez změn: reviewed="true" je finální
    const final = await engine.execute(s, engine.parse('<whisper turn="2">\n<read path="src/a.py"/>\n<done reviewed="true">Zkontrolováno.</done>\n</whisper>', 2), 1000);
    expect(final.kind).toBe("done");
  });

  it("a change made during the review triggers one more round, naming the files changed since", async () => {
    const { engine } = engineIn({});
    const s = createSession("Přidej a a b.", "stateful");
    await engine.execute(s, engine.parse(WRITE_DONE, 1), 1000);
    const again = await engine.execute(s, engine.parse('<whisper turn="2">\n<edit path="src/a.py">\n<<<<<<< SEARCH\nx = 1\n=======\nx = 3\n>>>>>>> REPLACE\n</edit>\n<done reviewed="true">Opraveno.</done>\n</whisper>', 2), 1000);
    expect(again.kind).toBe("next");
    if (again.kind !== "next") throw new Error("unreachable");
    expect(again.review).toEqual({ round: 2, files: ["src/a.py", "src/b.py"] });
    expect(again.prompt).toMatch(/REVIEW BEFORE DONE \(round 2\): you sent <done reviewed="true">, but since the last review you changed src\/a.py/);
    // plain <done> after a review with no further change is final too
    const final = await engine.execute(s, engine.parse('<whisper turn="3">\n<done>Hotovo, zkontrolováno.</done>\n</whisper>', 3), 1000);
    expect(final.kind).toBe("done");
  });

  it("is skipped when nothing was changed, when the block failed, or when the mode is off", async () => {
    const { engine } = engineIn({ "src/a.py": "x = 1\n" });
    const s = createSession("Vysvětli a.py.", "stateful");
    const step = await engine.execute(s, engine.parse('<whisper turn="1">\n<read path="src/a.py"/>\n<done>Je to x = 1.</done>\n</whisper>', 1), 1000);
    expect(step.kind).toBe("done");

    const { engine: off } = engineIn({}, false);
    const s2 = createSession("Přidej a a b.", "stateful");
    expect((await off.execute(s2, off.parse(WRITE_DONE, 1), 1000)).kind).toBe("done");

    // neúspěšná akce v bloku má přednost: nejdřív oprava, revize až po dalším done
    const { engine: e3 } = engineIn({});
    const s3 = createSession("Přidej a.", "stateful");
    const bad = await e3.execute(s3, e3.parse('<whisper turn="1">\n<write path="src/a.json">\n{"a": <![CDATA[1]]>}\n</write>\n<done>Hotovo.</done>\n</whisper>', 1), 1000);
    expect(bad.kind).toBe("next");
    if (bad.kind !== "next") throw new Error("unreachable");
    expect(bad.review).toBeUndefined();
    expect(bad.prompt).toMatch(/did not succeed/);
  });

  it("the rules describe the review flow unless the mode is off", () => {
    const ctx = { workspaceName: "demo", tree: "" };
    const on = buildPreamble(ctx, { mode: "stateful", maxChars: 1, resultMaxChars: 1, language: "cs" });
    expect(on).toMatch(/REVIEW BEFORE DONE: when files were changed, the first <done> is not final/);
    const off = buildPreamble(ctx, { mode: "stateful", maxChars: 1, resultMaxChars: 1, language: "cs", reviewBeforeDone: false });
    expect(off).not.toContain("REVIEW BEFORE DONE");
  });
});
