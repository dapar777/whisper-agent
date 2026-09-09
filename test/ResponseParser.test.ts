import { describe, expect, it } from "vitest";
import { parseReply } from "../src/protocol/ResponseParser";

describe("parseReply", () => {
  it("parses a mixed block with self-closing and body actions", () => {
    const reply = `Sure, let me look around.

<whisper turn="3">
<think>need context</think>
<read path="src/a.ts" lines="1-40"/>
<grep pattern="foo|bar" glob="src/**/*.ts"/>
<edit path="src/b.ts">
<<<<<<< SEARCH
const x = 1;
=======
const x = 2;
>>>>>>> REPLACE
</edit>
<write path="src/new.ts">
export const y = \`tpl \${x}\`;
</write>
<run timeout="60">npm test</run>
<status>working</status>
</whisper>`;
    const p = parseReply(reply);
    expect(p.errors).toEqual([]);
    expect(p.turn).toBe(3);
    expect(p.prose).toBe("Sure, let me look around.");
    expect(p.actions.map((a) => a.tool)).toEqual(["read", "grep", "edit", "write", "run", "status"]);
    expect(p.actions[0].attrs).toEqual({ path: "src/a.ts", lines: "1-40" });
    expect(p.actions[2].body).toContain("<<<<<<< SEARCH");
    expect(p.actions[3].body).toBe("export const y = `tpl ${x}`;");
    expect(p.actions[4].body).toBe("npm test");
  });

  it("takes the last block when an example precedes it, and tolerates code fences", () => {
    const reply = "Example: <whisper turn=\"1\"><read path=\"x\"/></whisper>\n```xml\n<whisper turn=\"2\">\n<ls path=\"src\"/>\n</whisper>\n```";
    const p = parseReply(reply);
    expect(p.turn).toBe(2);
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0].tool).toBe("ls");
  });

  it("normalises typographic quotes in attributes", () => {
    const p = parseReply("<whisper turn=“4”>\n<read path=„src/a.ts” />\n</whisper>");
    expect(p.turn).toBe(4);
    expect(p.actions[0].attrs.path).toBe("src/a.ts");
    expect(p.errors).toEqual([]);
  });

  it("reports missing block", () => {
    const p = parseReply("I cannot help with that.");
    expect(p.errors[0]).toMatch(/No <whisper/);
    expect(p.actions).toEqual([]);
  });

  it("reports missing closing tag and unknown actions", () => {
    const p = parseReply('<whisper turn="1">\n<read path="a"/>\n<fetch url="x"/>\n<write path="b">\nabc');
    expect(p.errors.some((e) => /Missing closing <\/whisper>/.test(e))).toBe(true);
    expect(p.errors.some((e) => /Unknown action <fetch>/.test(e))).toBe(true);
    expect(p.errors.some((e) => /Missing closing <\/write>/.test(e))).toBe(true);
    expect(p.actions.map((a) => a.tool)).toEqual(["read", "write"]);
  });

  it("supports a custom end marker for bodies containing the closing tag", () => {
    const p = parseReply('<whisper turn="1">\n<write path="doc.md" end="EOF_X">\ntext with </write> inside\nEOF_X\n</write>\n<ls/>\n</whisper>');
    expect(p.errors).toEqual([]);
    expect(p.actions[0].body).toBe("text with </write> inside");
    expect(p.actions[1].tool).toBe("ls");
  });

  it("does not treat tags inside a body as actions", () => {
    const p = parseReply('<whisper turn="1">\n<write path="a.html">\n<div><read path="nope"/></div>\n</write>\n</whisper>');
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0].body).toBe('<div><read path="nope"/></div>');
  });

  it("flags missing required attributes and empty bodies", () => {
    const p = parseReply('<whisper turn="1">\n<read/>\n<run></run>\n</whisper>');
    expect(p.errors).toContain('<read> is missing required attribute "path".');
    expect(p.errors).toContain("<run> has an empty body.");
  });

  it("skips an edit whose body contains a stray closing tag of another action", () => {
    const p = parseReply(
      '<whisper turn="4">\n<edit path="README.md">\n<<<<<<< SEARCH\na\n=======\nb\n```\n</write>\n>>>>>>> REPLACE\n</edit>\n<run>npm test</run>\n</whisper>',
    );
    expect(p.actions.map((a) => a.tool)).toEqual(["run"]);
    expect(p.errors[0]).toMatch(/SKIPPED.*stray closing tag <\/write>/);
  });

  it("ignores <whisper-results> echoed by the model", () => {
    const p = parseReply('<whisper-results turn="1"><result of="read"/></whisper-results>\n<whisper turn="2"><done>ok</done></whisper>');
    expect(p.turn).toBe(2);
    expect(p.actions[0].tool).toBe("done");
  });
});
