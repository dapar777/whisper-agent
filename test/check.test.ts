import { describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { NodeHost } from "../src/host/NodeHost";
import { TurnEngine } from "../src/agent/TurnEngine";
import { createSession } from "../src/session/SessionData";
import { checkWrittenFile } from "../src/tools/check";

function hostIn(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-check-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content, "utf8");
  }
  return { root, host: new NodeHost(root, { autoConfirm: true, log: () => undefined }) };
}

const hasPython = spawnSync("python", ["-c", "print(1)"], { windowsHide: true }).stdout?.toString().trim() === "1";

describe("checkWrittenFile: protocol residue", () => {
  it("flags CDATA, protocol tags, hunk markers and a whole-file fence", async () => {
    const { host } = hostIn({
      "a.md": "# T\n\n<![CDATA[\ntext\n]]>\n",
      "b.py": "x = 1\n</write>\n",
      "c.ts": "<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> REPLACE\n",
      "d.css": "```css\nbody { color: red }\n```\n",
    });
    expect((await checkWrittenFile(host, "a.md")).map((i) => i.message)).toEqual([expect.stringMatching(/^line 3: <!\[CDATA\[/)]);
    expect((await checkWrittenFile(host, "b.py")).map((i) => i.message)).toEqual([expect.stringMatching(/^line 2: protocol tag/), ...(hasPython ? [expect.stringMatching(/^Python syntax: line 2/)] : [])]);
    expect((await checkWrittenFile(host, "c.ts")).some((i) => /hunk markers/.test(i.message))).toBe(true);
    expect((await checkWrittenFile(host, "d.css")).map((i) => i.message)).toEqual([expect.stringMatching(/wrapped in a ``` code fence/)]);
  });

  it("warns about a file that is HTML-escaped throughout, but leaves real markup alone", async () => {
    const { host } = hostIn({
      "a.md": "# T\n\nuse `a &gt; b` and &lt;br&gt;\n",
      "page.html": "<p>&lt;b&gt; <![CDATA[x]]></p>\n",
      "doc.md": "# Protocol\n\n```\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n```\n",
    });
    const a = await checkWrittenFile(host, "a.md");
    expect(a).toEqual([{ severity: "warning", message: expect.stringMatching(/looks HTML-escaped/) }]);
    expect(await checkWrittenFile(host, "page.html")).toEqual([]);
    expect(await checkWrittenFile(host, "doc.md")).toEqual([]); // dokument smí hunky popisovat
  });
});

describe("checkWrittenFile: syntax", () => {
  it("validates JSON, skips comment-tolerant configs", async () => {
    const { host } = hostIn({ "bad.json": '{"a": 1,}\n', "ok.json": '﻿{"a": 1}\n', "tsconfig.json": '{ // c\n "a": 1 }\n' });
    expect((await checkWrittenFile(host, "bad.json")).map((i) => i.message)).toEqual([expect.stringMatching(/^JSON syntax:/)]);
    expect(await checkWrittenFile(host, "ok.json")).toEqual([]);
    expect(await checkWrittenFile(host, "tsconfig.json")).toEqual([]);
  });

  it.skipIf(!hasPython)("validates Python with the interpreter", async () => {
    const { host } = hostIn({ "bad.py": "def f(:\n    pass\n", "ok.py": "def f():\n    return 1\n" });
    expect((await checkWrittenFile(host, "bad.py")).map((i) => i.message)).toEqual([expect.stringMatching(/^Python syntax: line 1: /)]);
    expect(await checkWrittenFile(host, "ok.py")).toEqual([]);
  });

  it("validates JavaScript with node --check", async () => {
    const { host } = hostIn({ "bad.js": "function f( {\n}\n", "ok.js": "export const a = 1;\n" });
    expect((await checkWrittenFile(host, "bad.js")).map((i) => i.message)).toEqual([expect.stringMatching(/^JavaScript syntax: line \d+: /)]);
    expect(await checkWrittenFile(host, "ok.js")).toEqual([]);
  });

  it("validates TypeScript syntax through the project's typescript (this repo)", async () => {
    // TypeScript se bere z node_modules projektu: proto soubor v .tmp tohoto repa
    const dir = path.join(process.cwd(), ".tmp");
    fs.mkdirSync(dir, { recursive: true });
    const rel = `.tmp/check-${process.pid}.ts`;
    const host = new NodeHost(process.cwd(), { autoConfirm: true, log: () => undefined });
    try {
      fs.writeFileSync(path.join(process.cwd(), rel), "export const a: number = ;\n", "utf8");
      expect((await checkWrittenFile(host, rel)).map((i) => i.message)).toEqual([expect.stringMatching(/^TypeScript syntax: line 1: /)]);
      fs.writeFileSync(path.join(process.cwd(), rel), "export const a: number = 1;\nexport function f<T>(x: T): T { return x; }\n", "utf8");
      expect(await checkWrittenFile(host, rel)).toEqual([]);
    } finally {
      fs.rmSync(path.join(process.cwd(), rel), { force: true });
    }
  });
});

describe("engine: an invalid file blocks <done>", () => {
  it("marks the write as failed, tells the model how to fix it and keeps the task open", async () => {
    const { root, host } = hostIn({});
    const engine = new TurnEngine(host, { mode: "stateful", maxChars: 60000, resultMaxChars: 12000, language: "cs", treeMaxEntries: 50 });
    const s = createSession("Ulož konfiguraci.", "stateful");
    // CDATA uvnitř těla (ne kolem něj): parser ho nechá, do JSON nepatří
    const reply = '<whisper turn="1">\n<write path="config.json">\n{"a": <![CDATA[1]]>}\n</write>\n<done>Hotovo.</done>\n</whisper>';
    const step = await engine.execute(s, engine.parse(reply, 1), 1000);
    expect(step.kind).toBe("next");
    if (step.kind !== "next") throw new Error("unreachable");
    expect(fs.existsSync(path.join(root, "config.json"))).toBe(true);
    expect(step.prompt).toContain('<result of="write" path="config.json" status="error"');
    expect(step.prompt).toMatch(/was written, but it is NOT valid/);
    expect(step.prompt).toMatch(/CDATA/);
    expect(step.prompt).toMatch(/JSON syntax/);
    expect(step.prompt).toMatch(/You sent <done>, but 1 action\(s\) in that block did not succeed/);
  });
});
