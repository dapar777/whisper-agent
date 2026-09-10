import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { NodeHost } from "../src/host/NodeHost";
import { toolBundle, BUNDLE_MARKER } from "../src/tools/bundle";
import { isOwnPrompt, looksLikeReply } from "../src/protocol/replyDetect";
import { buildResultsPrompt, DEFAULT_OPTIONS } from "../src/protocol/PromptBuilder";
import { parseReply } from "../src/protocol/ResponseParser";

function tmpProject(files: Record<string, string | Buffer>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-bundle-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const host = (root: string) => new NodeHost(root, { autoConfirm: true, log: () => undefined });

describe("toolBundle", () => {
  it("bundles globs, directories and single files into one numbered text file", async () => {
    const root = tmpProject({
      "src/a.ts": "const a = 1;\nexport default a;\n",
      "src/b.ts": "export const b = 2;\n",
      "docs/readme.md": "# hi\n",
      "package.json": "{}\n",
      "img/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    const r = await toolBundle(host(root), { paths: "src/**/*.ts, docs, package.json, img/logo.png" }, 3, 1);
    expect(r.status).toBe("ok");
    expect(r.meta?.files).toBe(4);
    expect(r.attachments).toEqual([".whisper/out/bundle-3-1.txt"]);
    const content = fs.readFileSync(path.join(root, ".whisper/out/bundle-3-1.txt"), "utf8");
    expect(content.startsWith(BUNDLE_MARKER)).toBe(true);
    expect(content).toContain("#   src/a.ts (3 lines)");
    expect(content).toContain("===== FILE: src/a.ts (3 lines) =====\n1| const a = 1;\n2| export default a;\n3| \n===== END FILE: src/a.ts =====");
    expect(content).toContain("===== FILE: docs/readme.md");
    expect(content).toContain("===== FILE: package.json");
    expect(content).not.toContain("logo.png (");
    expect(r.output).toContain("Skipped:");
    expect(r.output).toContain("img/logo.png (binary)");
  });

  it("all=true takes the whole codebase but never .whisper or node_modules", async () => {
    const root = tmpProject({
      "a.py": "print(1)\n",
      "node_modules/x/index.js": "x",
      ".whisper/session.json": "{}",
    });
    const r = await toolBundle(host(root), { all: "true" }, 1, 2);
    expect(r.status).toBe("ok");
    expect(r.output).toContain("  a.py (2 lines)");
    expect(r.output).not.toContain("node_modules");
    expect(r.output).not.toContain("session.json");
  });

  it("fails clearly without paths and when nothing matches", async () => {
    const root = tmpProject({ "a.py": "x" });
    expect((await toolBundle(host(root), {}, 1, 1)).status).toBe("error");
    const none = await toolBundle(host(root), { paths: "nothing/**" }, 1, 1);
    expect(none.status).toBe("error");
    expect(none.output).toContain("No readable files matched");
  });

  it("a bundle on the clipboard is never mistaken for a reply, even if it contains whisper blocks", () => {
    const bundle = `${BUNDLE_MARKER}: 1 files\n===== FILE: test/x.ts =====\n1| const s = '<whisper turn="1"></whisper>';\n`;
    expect(isOwnPrompt(bundle)).toBe(true);
    expect(looksLikeReply(bundle, "")).toBe(false);
  });

  it("results prompt explains attached bundles and the preamble example parses", () => {
    const p = buildResultsPrompt(
      "s1",
      3,
      [{ tool: "bundle", attrs: { paths: "src/**" }, status: "ok", output: "Bundle written", meta: { file: ".whisper/out/bundle-2-1.txt", files: 4 }, attachments: [".whisper/out/bundle-2-1.txt"] }],
      {},
      DEFAULT_OPTIONS,
    );
    expect(p).toContain("Bundle(s) attached to this message: bundle-2-1.txt");
    expect(p).toContain('attached="bundle-2-1.txt"');
    expect(parseReply('<whisper turn="1"><bundle paths="src/**/*.ts, package.json"/></whisper>').actions[0].tool).toBe("bundle");
  });
});
