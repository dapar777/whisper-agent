import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { NodeHost } from "../src/host/NodeHost";
import { toolGrep } from "../src/tools/grep";

function tmpProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-grep-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content, "utf8");
  }
  return root;
}

describe("toolGrep", () => {
  it("merges overlapping context blocks and marks every matching line", async () => {
    const root = tmpProject({ "a.txt": ["l1", "hit one", "l3", "hit two", "l5", "l6", "l7", "l8", "l9", "hit three", "l11"].join("\n") });
    const host = new NodeHost(root, { autoConfirm: true, log: () => undefined });
    const r = await toolGrep(host, { pattern: "hit", context: "1" });
    expect(r.status).toBe("ok");
    expect(r.meta?.matches).toBe(3);
    expect(r.output).toBe(["a.txt:1- l1", "a.txt:2: hit one", "a.txt:3- l3", "a.txt:4: hit two", "a.txt:5- l5", "--", "a.txt:9- l9", "a.txt:10: hit three", "a.txt:11- l11", "--"].join("\n"));
  });

  it("without context prints one line per match", async () => {
    const root = tmpProject({ "b.txt": "x\nneedle\ny\nneedle\n" });
    const host = new NodeHost(root, { autoConfirm: true, log: () => undefined });
    const r = await toolGrep(host, { pattern: "needle" });
    expect(r.output).toBe("b.txt:2: needle\nb.txt:4: needle");
  });
});
