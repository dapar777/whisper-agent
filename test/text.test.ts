import { describe, expect, it } from "vitest";
import { globToRegExp, matchesAny } from "../src/protocol/text";

describe("globToRegExp", () => {
  it("handles ** and * and ?", () => {
    const re = globToRegExp("src/**/*.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/x/y/z.ts")).toBe(true);
    expect(re.test("lib/a.ts")).toBe(false);
    expect(globToRegExp("a?.js").test("ab.js")).toBe(true);
    expect(globToRegExp("*.md").test("dir/x.md")).toBe(false);
  });

  it("handles brace alternatives containing globs (the pattern that used to throw)", () => {
    const re = globToRegExp("app/src/main/{java/**/*.kt,assets/*.html}");
    expect(re.test("app/src/main/java/com/x/Main.kt")).toBe(true);
    expect(re.test("app/src/main/assets/index.html")).toBe(true);
    expect(re.test("app/src/main/assets/sub/index.html")).toBe(false);
    expect(re.test("app/src/main/res/a.xml")).toBe(false);
  });

  it("handles nested braces and character classes", () => {
    const re = globToRegExp("**/*.{ts,js{,x}}");
    expect(re.test("a/b.jsx")).toBe(true);
    expect(re.test("a/b.js")).toBe(true);
    expect(re.test("a/b.ts")).toBe(true);
    expect(re.test("a/b.tsx")).toBe(false);
    expect(globToRegExp("file[0-9].txt").test("file7.txt")).toBe(true);
  });

  it("matchesAny never throws on a broken pattern", () => {
    expect(matchesAny("a.ts", ["{unclosed", "(", "**/*.ts"])).toBe(true);
    expect(matchesAny("a.py", ["("])).toBe(false);
  });
});
