import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describeRef, parseRefs, rangeFor } from "../src/protocol/refs";
import { renderRefs, resolveRefs } from "../src/tools/refs";
import { NodeHost } from "../src/host/NodeHost";

const tmp = (files: Record<string, string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-refs-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content, "utf8");
  }
  return root;
};
const host = (root: string) => new NodeHost(root, { autoConfirm: true, log: () => undefined });

describe("parseRefs", () => {
  it("finds paths, ranges, single lines and the editor shorthands", () => {
    const refs = parseRefs("Oprav #src/app.ts a #src/b.ts:40-80, pak #c.ts:120 podle #selection a #file");
    expect(refs.map((r) => [r.kind, r.path, r.from, r.to])).toEqual([
      ["path", "src/app.ts", undefined, undefined],
      ["path", "src/b.ts", 40, 80],
      ["path", "c.ts", 120, 120],
      ["selection", "", undefined, undefined],
      ["file", "", undefined, undefined],
    ]);
  });

  it("ignores text without refs and deduplicates", () => {
    expect(parseRefs("bez odkazu, jen #")).toEqual([]);
    expect(parseRefs("#a.ts a zase #a.ts")).toHaveLength(1);
  });

  it("stops at sentence punctuation and normalises backslashes", () => {
    expect(parseRefs("v #src/app.ts, dál").map((r) => r.path)).toEqual(["src/app.ts"]);
    expect(parseRefs("#src\\win\\file.ts").map((r) => r.path)).toEqual(["src/win/file.ts"]);
  });

  it("a single line gets surrounding context, a range is used as given", () => {
    expect(rangeFor(parseRefs("#a.ts:100")[0], 500)).toEqual({ from: 80, to: 120 });
    expect(rangeFor(parseRefs("#a.ts:10-20")[0], 500)).toEqual({ from: 10, to: 20 });
    expect(rangeFor(parseRefs("#a.ts:5")[0], 12)).toEqual({ from: 1, to: 12 }); // ořezáno na délku souboru
    expect(rangeFor(parseRefs("#a.ts")[0], 500)).toBeUndefined();
  });

  it("describes refs for the UI", () => {
    expect(describeRef(parseRefs("#a/b.ts:3-9")[0])).toBe("a/b.ts:3-9");
    expect(describeRef(parseRefs("#selection")[0])).toBe("výběr v editoru");
  });
});

describe("resolveRefs", () => {
  it("reads whole files and ranges with line numbers", async () => {
    const root = tmp({ "src/app.ts": Array.from({ length: 6 }, (_, i) => `line ${i + 1}`).join("\n") });
    const out = await resolveRefs(host(root), "mrkni na #src/app.ts:2-3");
    expect(out).toHaveLength(1);
    expect(out[0].ok).toBe(true);
    expect(out[0].lines).toBe("2-3");
    expect(out[0].content).toBe("2| line 2\n3| line 3");
  });

  it("reports a missing file and suggests a similar one instead of failing", async () => {
    const root = tmp({ "src/deep/config.ts": "x" });
    const out = await resolveRefs(host(root), "#config.ts");
    expect(out[0].ok).toBe(false);
    expect(out[0].content).toContain("soubor neexistuje");
    expect(out[0].content).toContain("src/deep/config.ts");
  });

  it("resolves #file and #selection from the editor, and says when there is nothing", async () => {
    const root = tmp({ "a.ts": "const a = 1;\nconst b = 2;\n" });
    const withEditor = await resolveRefs(host(root), "#file a #selection", { path: "a.ts", selection: "const b = 2;", selectionRange: "2-2" });
    expect(withEditor[0].content).toContain("const a = 1;");
    expect(withEditor[1].content).toBe("const b = 2;");
    const without = await resolveRefs(host(root), "#selection");
    expect(without[0].ok).toBe(false);
    expect(without[0].content).toContain("není nic vybráno");
  });

  it("one broken ref does not stop the others", async () => {
    const root = tmp({ "a.ts": "ok" });
    const out = await resolveRefs(host(root), "#nope.ts a #a.ts");
    expect(out.map((r) => r.ok)).toEqual([false, true]);
  });

  it("renders a block the model can read, empty when nothing was referenced", async () => {
    const root = tmp({ "a.ts": "ok" });
    expect(renderRefs(await resolveRefs(host(root), "bez odkazu"))).toBe("");
    const block = renderRefs(await resolveRefs(host(root), "#a.ts"));
    expect(block).toContain("## Files the user referenced");
    expect(block).toContain("### a.ts");
    expect(block).toContain("1| ok");
  });
});
