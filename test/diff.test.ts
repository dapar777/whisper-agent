import { describe, expect, it } from "vitest";
import { diffLines } from "../src/protocol/diff";

describe("diffLines", () => {
  it("returns no hunks for identical text", () => {
    expect(diffLines("a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("finds a single changed line", () => {
    const h = diffLines("a\nb\nc\n", "a\nB\nc\n");
    expect(h).toEqual([{ oldStart: 1, oldLines: ["b"], newStart: 1, newLines: ["B"] }]);
  });

  it("separates distant hunks and handles pure insertions and deletions", () => {
    const h = diffLines("1\n2\n3\n4\n5\n6", "1\nX\n2\n3\n4\n6");
    expect(h).toHaveLength(2);
    expect(h[0]).toEqual({ oldStart: 1, oldLines: [], newStart: 1, newLines: ["X"] });
    expect(h[1]).toEqual({ oldStart: 4, oldLines: ["5"], newStart: 5, newLines: [] });
  });

  it("treats a new file as one insertion hunk", () => {
    const h = diffLines("", "a\nb");
    expect(h).toHaveLength(1);
    expect(h[0].newLines).toEqual(["a", "b"]);
  });
});
