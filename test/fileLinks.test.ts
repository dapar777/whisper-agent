import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Linkování cest na klikací odkazy žije ve webview skriptu (šablona v SidebarView).
 * Test vytáhne funkci linkFiles z bundlu a ověří ji přímo, ať se regrese pozná bez klikání.
 */
function loadLinkFiles(): (html: string) => string {
  const src = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
  const i = src.indexOf("const linkFiles");
  expect(i).toBeGreaterThan(0);
  // funkce končí před definicí inline formátovače
  const end = src.indexOf("const inline", i);
  let body = src.slice(i, end);
  // v bundlu je to uvnitř template literálu: zpětná lomítka jsou zdvojená
  body = body.replace(/\\\\/g, "\\").replace(/\\`/g, "`").replace(/\\\$/g, "$");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(body + "; return linkFiles;")() as (html: string) => string;
}

const linkFiles = loadLinkFiles();
const paths = (html: string) => [...html.matchAll(/data-path="([^"]*)" data-line="([^"]*)"/g)].map((m) => m[1] + (m[2] ? ":" + m[2] : ""));

describe("clickable code locations in model output", () => {
  it("links a path with a line and a plain path", () => {
    expect(paths(linkFiles("Chyba v src/tools/bundle.ts:74 a v test/refs.test.ts."))).toEqual(["src/tools/bundle.ts:74", "test/refs.test.ts"]);
  });

  it("keeps line and column", () => {
    const out = linkFiles("viz src/a.ts:12:5 dál");
    expect(out).toContain('data-line="12"');
    expect(out).toContain('data-col="5"');
    expect(out).toContain(">src/a.ts:12:5<");
  });

  it("does not link a bare file name without a directory", () => {
    expect(paths(linkFiles("Uprav package.json a README.md"))).toEqual([]);
  });

  it("does not link prose containing a dot, a version or a URL host", () => {
    expect(paths(linkFiles("verze 1.2.3 a text. Další věta"))).toEqual([]);
  });

  it("links inside inline code and at the start of a line", () => {
    expect(paths(linkFiles("<code>src/a/b.py:9</code>"))).toEqual(["src/a/b.py:9"]);
    expect(paths(linkFiles("src/start.ts:1 na začátku"))).toEqual(["src/start.ts:1"]);
  });

  it("handles several links in one sentence", () => {
    expect(paths(linkFiles("z a/b.ts:1 do c/d.ts:2 a e/f.ts"))).toEqual(["a/b.ts:1", "c/d.ts:2", "e/f.ts"]);
  });
});
