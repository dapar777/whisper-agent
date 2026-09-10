import { describe, expect, it } from "vitest";
import { describeActions, describeResults, Transcript } from "../src/transcript/Transcript";

describe("transcript descriptions", () => {
  it("describes actions with their targets and run commands", () => {
    const text = describeActions([
      { tool: "read", attrs: { path: "src/a.ts" } },
      { tool: "run", attrs: {}, body: "npm test\n" },
      { tool: "status", attrs: {}, body: "hotovo" },
    ]);
    expect(text).toBe("read src/a.ts, run npm test");
  });

  it("keeps the reason of every failure and only counts successes", () => {
    const text = describeResults([
      { tool: "edit", attrs: { path: "src/a.ts" }, status: "ok" },
      { tool: "run", attrs: {}, status: "ok", output: "all good", meta: { command: "npm test", exit: 0 } },
      {
        tool: "run",
        attrs: {},
        status: "error",
        meta: { command: "python -m todo", exit: 1 },
        output: "[timed out after 180s and was killed; for GUI apps or servers use probe=\"N\" instead]\n(no output)",
      },
      {
        tool: "run",
        attrs: {},
        status: "error",
        meta: { command: "npm test", exit: 1 },
        output: "> app@1.0.0 test\n\nTAP version 13\nnot ok 3 - export writes BOM\n",
      },
      { tool: "edit", attrs: { path: "src/b.ts" }, status: "error", output: "SEARCH text not found (hunk 1)" },
    ]);
    expect(text).toContain("5 výsledků, 3 neúspěšných");
    expect(text).toContain("2 ok (edit src/a.ts, run `npm test`)");
    expect(text).toContain("run `python -m todo` → error exit=1: timed out after 180s and was killed");
    expect(text).toContain("run `npm test` → error exit=1: not ok 3 - export writes BOM");
    expect(text).toContain("edit src/b.ts → error: SEARCH text not found (hunk 1)");
  });

  it("summarize keeps failing turns in full", () => {
    const long = "20 výsledků, 1 neúspěšných: 19 ok (" + Array.from({ length: 19 }, (_, i) => `read f${i}.ts`).join(", ") + "); run `npm test` → error exit=1: not ok 7 - the failing one";
    const text = Transcript.summarize([
      { at: "", session: "s", kind: "task", text: "t" },
      { at: "", session: "s", kind: "results", turn: 2, text: long },
    ]);
    expect(text).toContain("not ok 7 - the failing one");
  });
});
