import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { NodeHost } from "../src/host/NodeHost";
import { TurnEngine } from "../src/agent/TurnEngine";
import { createSession } from "../src/session/SessionData";

function engineIn(files: Record<string, string>, initialBundle: "off" | "full") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-initial-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content, "utf8");
  }
  const host = new NodeHost(root, { autoConfirm: true, log: () => undefined });
  const engine = new TurnEngine(host, { mode: "stateful", maxChars: 60000, resultMaxChars: 12000, language: "cs", treeMaxEntries: 50, initialBundle, initialBundleMaxChars: 100_000 });
  return { root, engine };
}

const FILES = { "src/a.py": "x = 1\n", "src/b.py": "y = 2\n", "README.md": "# demo\n" };

describe("full bundle with the initial prompt", () => {
  it("attaches the whole codebase and tells the model to use it instead of <read>", async () => {
    const { root, engine } = engineIn(FILES, "full");
    const s = createSession("Přidej c.", "stateful");
    const ctx = await engine.gatherContext();
    const attachments = await engine.attachInitialBundle(s, ctx, 1);
    expect(attachments).toEqual([expect.stringMatching(/^\.whisper\/out\/bundle-1-0-\d{6}-\d{4}\.txt$/)]);
    expect(ctx.initialBundle).toMatchObject({ file: attachments[0], files: 3, skipped: 0 });
    const content = fs.readFileSync(path.join(root, attachments[0]), "utf8");
    expect(content).toContain("===== FILE: src/a.py (2 lines) =====");
    expect(content).toContain("===== FILE: README.md");
    const prompt = await engine.initialPrompt(s, ctx);
    expect(prompt).toContain("## Attached: complete codebase bundle");
    expect(prompt).toContain(`The file ${attachments[0]} attached to this message holds the complete codebase: 3 files`);
    expect(prompt).toMatch(/Read it instead of requesting files with <read> or <bundle>/);
  });

  it("does nothing when the option is off", async () => {
    const { engine } = engineIn(FILES, "off");
    const s = createSession("Přidej c.", "stateful");
    const ctx = await engine.gatherContext();
    expect(await engine.attachInitialBundle(s, ctx, 1)).toEqual([]);
    expect(ctx.initialBundle).toBeUndefined();
    expect(await engine.initialPrompt(s, ctx)).not.toContain("complete codebase bundle");
  });
});
