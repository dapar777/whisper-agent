import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { parseReply } from "../src/protocol/ResponseParser";
import { applySection, findHeadings, outline } from "../src/protocol/section";
import { applyHunks, parseHunks } from "../src/protocol/edit";
import { buildCorrectionPrompt, buildRules, classifyProse, DEFAULT_OPTIONS } from "../src/protocol/PromptBuilder";

const REAL = fs.readFileSync(path.join(__dirname, "fixtures", "md-reply.md"), "utf8");

const DOC = `# Navrh
Ukazka bloku agenta:

<whisper turn="4">
<status>Pridavam obalku.</status>
<edit path="todo/storage.py">
<<<<<<< SEARCH
a
=======
b
>>>>>>> REPLACE
</edit>
<run>python -m unittest</run>
</whisper>

Kod:

\`\`\`python
print("x")
\`\`\`

Konec dokumentu.`;

describe("markdown documents in replies (parser)", () => {
  it("real Opus reply: a document with an embedded <whisper> example and a <whisper> mention in <done>", () => {
    const p = parseReply(REAL, 2);
    expect(p.turn).toBe(2);
    expect(p.actions.map((a) => a.tool)).toEqual(["status", "write", "ls", "grep", "done"]);
    expect(p.errors).toEqual([]);
    const body = p.actions[1].body!;
    expect(body).toContain('<whisper turn="4">');
    expect(body).toContain("<<<<<<< SEARCH"); // escaped hunk markers decoded
    expect(body).not.toContain("&lt;&lt;");
    expect(body).toContain("## Otevrene otazky");
    expect(body.trimEnd().endsWith("jednim JSON souborem.")).toBe(true);
  });

  it("a write body may contain a full <whisper> example and </edit>", () => {
    const p = parseReply(`<whisper turn="2">\n<write path="docs/x.md">\n${DOC}\n</write>\n<done>Hotovo, blok <whisper> je v dokumentu.</done>\n</whisper>`);
    expect(p.actions.map((a) => a.tool)).toEqual(["write", "done"]);
    expect(p.actions[0].body).toContain("</edit>");
    expect(p.actions[0].body!.endsWith("Konec dokumentu.")).toBe(true);
    expect(p.errors).toEqual([]);
  });

  it("the literal text </write> inside a document does not end the body", () => {
    const p = parseReply(`<whisper turn="3">\n<write path="docs/p.md">\nPouzij tag </write> na konci.\n\nDalsi odstavec.\n</write>\n<status>ok</status>\n</whisper>`);
    expect(p.actions.map((a) => a.tool)).toEqual(["write", "status"]);
    expect(p.actions[0].body).toBe("Pouzij tag </write> na konci.\n\nDalsi odstavec.");
  });

  it("whole reply in a fence, document with inner fences; a fenced write body is unwrapped with a note", () => {
    const p = parseReply("```xml\n<whisper turn=\"5\">\n<write path=\"a.md\">\n```markdown\n# T\n\n```js\nconsole.log(1)\n```\n```\n</write>\n</whisper>\n```");
    expect(p.actions[0].body).toBe("# T\n\n```js\nconsole.log(1)\n```");
    expect(p.notes[0]).toMatch(/wrapped in a ``` fence/);
  });

  it("a cut-off reply skips the unfinished action but keeps the complete ones", () => {
    const p = parseReply(`<whisper turn="2">\n<write path="a.md">\nhello\n</write>\n<run>npm test`);
    expect(p.actions.map((a) => a.tool)).toEqual(["write"]);
    expect(p.errors.join(" ")).toMatch(/Missing closing <\/run>.*SKIPPED/);
    expect(p.errors.join(" ")).toMatch(/Missing closing <\/whisper>/);
  });

  it("chooses the real block among examples, previews and mentions", () => {
    const two = parseReply(`Priklad:\n<whisper turn="1">\n<read path="old.ts"/>\n</whisper>\n\nSkutecna odpoved:\n<whisper turn="2">\n<read path="new.ts"/>\n</whisper>`);
    expect(two.turn).toBe(2);
    expect(two.actions[0].attrs.path).toBe("new.ts");
    const preview = parseReply(`<whisper turn="3">\n<read path="three.ts"/>\n</whisper>\nNext turn will be:\n<whisper turn="4">\n<read path="four.ts"/>\n</whisper>`, 3);
    expect(preview.turn).toBe(3);
    const mention = parseReply(`<whisper turn="2">\n<read path="a.ts"/>\n<done>Blok <whisper> je vysvetlen v docs.</done>\n</whisper>`);
    expect(mention.actions.map((a) => a.tool)).toEqual(["read", "done"]);
  });

  it("typographic quotes stay verbatim in bodies (only attributes are normalised)", () => {
    const p = parseReply(`<whisper turn=“2”>\n<write path=“a.md”>\nŘekl: „ahoj“\n</write>\n</whisper>`);
    expect(p.turn).toBe(2);
    expect(p.actions[0].attrs.path).toBe("a.md");
    expect(p.actions[0].body).toBe("Řekl: „ahoj“");
  });

  it("a custom end marker only counts at line start, so <<EOF in a heredoc does not end the body", () => {
    const p = parseReply(`<whisper turn="2">\n<write path="s.sh" end="EOF">\ncat <<EOF > x\nhi\nEOF\necho done\nEOF</write>\n<status>ok</status>\n</whisper>`);
    expect(p.actions.map((a) => a.tool)).toEqual(["write", "status"]);
    expect(p.actions[0].body).toBe("cat <<EOF > x\nhi\nEOF\necho done");
  });

  it("HTML in markdown and CRLF are fine", () => {
    const p = parseReply(`<whisper turn="2">\r\n<write path="a.md">\r\n<details><summary>x</summary>\r\n<img src="a.png">\r\n</details>\r\n</write>\r\n</whisper>\r\n`);
    expect(p.actions[0].body).toBe('<details><summary>x</summary>\n<img src="a.png">\n</details>');
    expect(p.errors).toEqual([]);
  });
});

describe("HTML-escaped protocol tags", () => {
  it("decodes a reply whose tags were escaped as &lt;…&gt; and tells the model", () => {
    const doc = "# Navrh\n\n## Cile\n\n- a\n- b\n- c\n\n" + "text ".repeat(100);
    const reply =
      "Tady je blok:\n\n```xml\n&lt;whisper turn=\"1\"&gt;\n  &lt;status&gt;jdu na to&lt;/status&gt;\n  &lt;write path=\"docs/navrh.md\"&gt;\n" +
      doc +
      "\n  &lt;/write&gt;\n  &lt;done&gt;hotovo&lt;/done&gt;\n&lt;/whisper&gt;\n```\n\n**Notes**\n- Špičaté závorky jsem převedl na entity.\n";
    const p = parseReply(reply, 1);
    expect(p.errors).toEqual([]);
    expect(p.actions.map((a) => a.tool)).toEqual(["status", "write", "done"]);
    expect(p.actions[1].attrs.path).toBe("docs/navrh.md");
    expect(p.actions[1].body).toContain("## Cile");
    expect(p.notes[0]).toMatch(/HTML-escaped/);
    expect(p.raw).toBe(reply);
  });

  it("leaves a normal reply alone even when it mentions &lt;whisper&gt; in prose", () => {
    const reply = 'Pozn.: tag &lt;whisper&gt; se nepíše do fence.\n<whisper turn="1"><read path="a.ts"/></whisper>';
    const p = parseReply(reply, 1);
    expect(p.actions.map((a) => a.tool)).toEqual(["read"]);
    expect(p.notes).toEqual([]);
  });
});

describe("markdown sections", () => {
  const MD = ["# Navrh", "", "## Cile", "", "- a", "", "## Rizika", "", "- r1", "", "```python", "# ne nadpis", "```", "", "### Rizika: detail", "", "text", "", "## Otevřené otázky", "", "1. co", ""].join("\n");

  it("headings ignore fenced code, sections swallow their subsections, heading kept unless replaced", () => {
    expect(findHeadings(MD).map((h) => h.text)).toEqual(["Navrh", "Cile", "Rizika", "Rizika: detail", "Otevřené otázky"]);
    const r = applySection(MD, "Rizika", "- nove\n- druhe");
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("## Rizika\n\n- nove\n- druhe\n\n## Otevřené otázky");
    expect(r.content).not.toContain("Rizika: detail");
    const withHeading = applySection(MD, "## Cile", "## Cíle projektu\n\n- x");
    expect(withHeading.content).toContain("## Cíle projektu\n\n- x\n\n## Rizika");
  });

  it("matches without diacritics, reports ambiguity and missing sections with the heading list", () => {
    expect(applySection(MD, "otevrene otazky", "2. nic").content.endsWith("## Otevřené otázky\n\n2. nic\n")).toBe(true);
    expect(applySection(MD, "Riz", "x").error).toMatch(/ambiguous[\s\S]*L7[\s\S]*L15/);
    expect(applySection(MD, "Testovani", "x").error).toMatch(/not found[\s\S]*L3: ## Cile/);
    expect(applySection("no headings here", "X", "y").error).toMatch(/no markdown headings/);
  });

  it("insert=before/after adds a new section next to an existing one and refuses a body without heading", () => {
    const r = applySection(MD, "Rizika", "## Testování\n\n- t1\n- t2", "before");
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("\n\n## Testování\n\n- t1\n- t2\n\n## Rizika\n");
    expect(r.replaced).toEqual({ from: 7, to: 10, heading: "## Rizika" });
    const after = applySection(MD, "Rizika", "## Testování\n\n- t1", "after");
    expect(after.content).toContain("text\n\n## Testování\n\n- t1\n\n## Otevřené otázky");
    expect(applySection(MD, "Rizika", "- bez nadpisu", "after").error).toMatch(/needs a body that starts with a heading/);
  });

  it("outline lists headings for markdown and top-level declarations for code", () => {
    expect(outline(MD, "docs/n.md")).toContain("L15: ### Rizika: detail");
    expect(outline(MD, "docs/n.md")).not.toContain("ne nadpis");
    const code = "import x\n\nexport function alpha() {}\n  const inner = 1\nexport class Beta {}\ndef gamma():\n    pass\n";
    const o = outline(code, "a.ts");
    expect(o).toContain("L3: export function alpha");
    expect(o).toContain("L6: def gamma");
    expect(o).not.toContain("inner");
  });
});

describe("edit robustness on prose", () => {
  it("setext underline inside SEARCH does not split the hunk", () => {
    const body = "<<<<<<< SEARCH\nTitle\n=====\nold line\n=======\nTitle\n=====\nnew line\n>>>>>>> REPLACE";
    const h = parseHunks(body);
    expect(h).toHaveLength(1);
    expect(h[0].search).toBe("Title\n=====\nold line");
    expect(h[0].replace).toBe("Title\n=====\nnew line");
    const r = applyHunks("Intro\n\nTitle\n=====\nold line\n", h);
    expect(r.applied).toBe(1);
    expect(r.content).toContain("Title\n=====\nnew line");
  });

  it("line-number prefixes copied from <read> are stripped with a note", () => {
    const r = applyHunks("alpha\nbeta\ngamma\n", parseHunks("<<<<<<< SEARCH\n2| beta\n=======\nBETA\n>>>>>>> REPLACE"));
    expect(r.applied).toBe(1);
    expect(r.content).toBe("alpha\nBETA\ngamma\n");
    expect(r.notes[0]).toMatch(/line-number prefixes/);
  });

  it("typographic quotes in the file match straight quotes in SEARCH", () => {
    const r = applyHunks("Řekl: „ahoj“ a šel.\n", parseHunks('<<<<<<< SEARCH\nŘekl: "ahoj" a šel.\n=======\nŘekl: „nazdar“ a šel.\n>>>>>>> REPLACE'));
    expect(r.applied).toBe(1);
    expect(r.content).toBe("Řekl: „nazdar“ a šel.\n");
  });

  it("an ambiguous SEARCH is refused with the matching lines instead of silently hitting the first one", () => {
    const r = applyHunks("## A\n- item\n## B\n- item\n", parseHunks("<<<<<<< SEARCH\n- item\n=======\n- changed\n>>>>>>> REPLACE"));
    expect(r.applied).toBe(0);
    expect(r.failures[0].reason).toMatch(/ambiguous.*lines 2, 4/);
  });

  it("a reflowed paragraph matches by words and the whole paragraph is replaced", () => {
    const file = "Intro.\n\nThis is a long paragraph that the\nmodel will copy with different\nline breaks entirely.\n\nEnd.\n";
    const r = applyHunks(file, parseHunks("<<<<<<< SEARCH\nThis is a long paragraph that the model will copy\nwith different line breaks entirely.\n=======\nShort now.\n>>>>>>> REPLACE"));
    expect(r.applied).toBe(1);
    expect(r.content).toBe("Intro.\n\nShort now.\n\nEnd.\n");
    expect(r.notes[0]).toMatch(/reflowed/);
  });

  it("a not-found SEARCH explains which line resembles it, with a non-copyable prefix", () => {
    const r = applyHunks("one\ntwo\nthree\n", parseHunks("<<<<<<< SEARCH\ntwo\nfour\n=======\nx\n>>>>>>> REPLACE"));
    expect(r.failures[0].reason).toMatch(/resembles line 2/);
    expect(r.failures[0].reason).toMatch(/L2: two/);
  });
});

describe("block-less replies", () => {
  it("classifies a document, a question and other text", () => {
    expect(classifyProse("# Navrh\n\n## Cile\n- a\n- b\n- c\n" + "x".repeat(400))).toBe("document");
    expect(classifyProse("Máš na mysli Python nebo TypeScript verzi?")).toBe("question");
    expect(classifyProse("Rozumím, pokračuji.")).toBe("other");
  });

  it("the correction prompt tells a document-writer to use <write> and escalates on the second attempt", () => {
    const doc = "# Navrh\n\n## Cile\n- a\n- b\n- c\n" + "x".repeat(400);
    const p1 = buildCorrectionPrompt("s", 2, ["No <whisper> block"], { task: "Napiš docs/navrh.md", prose: doc, attempt: 1, userNotes: ["pozn"], savedTo: ".whisper/out/reply-2-1.md" });
    expect(p1).toMatch(/NOTHING was executed/);
    expect(p1).toContain('<write path="docs/navrh.md">');
    expect(p1).toContain("<task>Napiš docs/navrh.md</task>");
    expect(p1).toContain("<user>pozn</user>");
    expect(p1).toContain(".whisper/out/reply-2-1.md");
    expect(p1).not.toMatch(/correction attempt/);
    const p2 = buildCorrectionPrompt("s", 2, [], { prose: doc, attempt: 2 });
    expect(p2).toMatch(/correction attempt 2/);
    expect(p2).toMatch(/Start your reply with <whisper turn="2">/);
  });

  it("for an existing document the correction points to section edits, not to a full <write>", () => {
    const doc = "# Navrh\n\n## Cile\n- a\n- b\n- c\n" + "x".repeat(400);
    const p = buildCorrectionPrompt("s", 2, [], { prose: doc, existingDoc: "docs/navrh.md" });
    expect(p).toMatch(/NOTHING was changed/);
    expect(p).toContain('<edit path="docs/navrh.md" section="## Existing heading">');
    expect(p).toContain('insert="before"');
    expect(p).not.toContain('<write path="docs/navrh.md">');
  });

  it("the preamble carries the documents rule", () => {
    expect(buildRules(DEFAULT_OPTIONS)).toMatch(/DOCUMENTS ARE FILES/);
  });
});
