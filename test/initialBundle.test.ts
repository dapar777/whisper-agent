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
  const engine = new TurnEngine(host, { mode: "stateful", maxChars: 60000, resultMaxChars: 12000, language: "cs", treeMaxEntries: 50, initialBundle });
  return { root, engine };
}

// velký soubor: v běžném <bundle> by byl přeskočen (limit 200 000 znaků), do full bundlu patří všechno
const FILES = { "src/a.py": "x = 1\n", "src/b.py": "y = 2\n", "README.md": "# demo\n", "data/big.txt": "z\n".repeat(150_000) };

describe("full bundle with the initial prompt", () => {
  it("attaches the whole codebase and tells the model to use it instead of <read>", async () => {
    const { root, engine } = engineIn(FILES, "full");
    const s = createSession("Přidej c.", "stateful");
    const ctx = await engine.gatherContext();
    const attachments = await engine.attachInitialBundle(s, ctx, 1);
    expect(attachments).toEqual([expect.stringMatching(/^\.whisper\/out\/bundle-1-0-\d{6}-\d{4}\.txt$/)]);
    expect(ctx.initialBundle).toMatchObject({ file: attachments[0], files: 4, skipped: 0, format: "compact" });
    const content = fs.readFileSync(path.join(root, attachments[0]), "utf8");
    // úsporný formát: hlavička a obsah beze změny, bez čísel řádků, bez END značek a bez obsahu na začátku
    expect(content).toContain("===== FILE: src/a.py (2 lines) =====\nx = 1\n\n===== FILE: src/b.py (2 lines) =====\ny = 2\n");
    expect(content).not.toContain("END FILE");
    expect(content).not.toContain("1| ");
    expect(content).not.toContain("# Contents:");
    expect(content).toContain("===== FILE: data/big.txt (150001 lines) =====");
    expect(content.length).toBeGreaterThan(300_000);
    const prompt = await engine.initialPrompt(s, ctx);
    expect(prompt).toContain("## Attached: complete codebase bundle");
    expect(prompt).toContain(`The file ${attachments[0]} attached to this message holds the complete codebase: 4 files, each starting with '===== FILE: <path> =====' and continuing verbatim (no line numbers)`);
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
