import { describe, expect, it } from "vitest";
import * as path from "path";
import { relOf, resolveRel, splitGlob, uniqueRoots } from "../src/protocol/roots";

const A = path.resolve("/ws/app");
const B = path.resolve("/other/lib");
const ROOTS = uniqueRoots([
  { name: "app", fsPath: A },
  { name: "lib", fsPath: B },
]);
const SINGLE = uniqueRoots([{ name: "app", fsPath: A }]);

describe("multi-root paths", () => {
  it("keeps a single folder unprefixed and rejects escapes", () => {
    expect(resolveRel("src/x.ts", SINGLE).fsPath).toBe(path.join(A, "src", "x.ts"));
    expect(relOf(path.join(A, "src", "x.ts"), SINGLE)).toBe("src/x.ts");
    expect(() => resolveRel("../secret", SINGLE)).toThrow(/mimo workspace/);
  });

  it("prefixes paths with the folder name when there are several folders", () => {
    expect(resolveRel("lib/README.md", ROOTS)).toMatchObject({ fsPath: path.join(B, "README.md"), inside: "README.md" });
    expect(resolveRel("app/src/x.ts", ROOTS).folder.name).toBe("app");
    expect(relOf(path.join(B, "src", "y.ts"), ROOTS)).toBe("lib/src/y.ts");
    expect(relOf(path.resolve("/elsewhere/z.ts"), ROOTS)).toBeUndefined();
    // stav agenta patří do první složky
    expect(resolveRel(".whisper/out/bundle.txt", ROOTS).fsPath).toBe(path.join(A, ".whisper", "out", "bundle.txt"));
    // cesta bez názvu složky: chyba s nápovědou (žádné tiché hledání v první složce)
    expect(() => resolveRel("src/x.ts", ROOTS)).toThrow(/začínají jejich názvem: app\/…, lib\/…/);
    // `lib/../app/x` není cesta do složky app, ale únik ze složky lib: odmítá se
    expect(() => resolveRel("lib/../app/x", ROOTS)).toThrow(/mimo workspace/);
  });

  it("does not let a folder-prefixed path escape its folder", () => {
    expect(() => resolveRel("lib/../../etc/passwd", ROOTS)).toThrow(/mimo workspace/);
  });

  it("makes duplicate folder names unique", () => {
    const r = uniqueRoots([
      { name: "app", fsPath: A },
      { name: "app", fsPath: B },
    ]);
    expect(r.map((x) => x.name)).toEqual(["app", "app-2"]);
    expect(resolveRel("app-2/x", r).fsPath).toBe(path.join(B, "x"));
  });

  it("splits a glob into per-folder searches", () => {
    expect(splitGlob("**/*.ts", ROOTS)).toEqual([
      { folder: ROOTS[0], glob: "**/*.ts" },
      { folder: ROOTS[1], glob: "**/*.ts" },
    ]);
    expect(splitGlob("lib/src/**/*.ts", ROOTS)).toEqual([{ folder: ROOTS[1], glob: "src/**/*.ts" }]);
    expect(splitGlob("lib", ROOTS)).toEqual([{ folder: ROOTS[1], glob: "**/*" }]);
    expect(splitGlob("src/**", SINGLE)).toEqual([{ folder: SINGLE[0], glob: "src/**" }]);
  });
});
