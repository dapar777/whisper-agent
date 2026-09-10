import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadSkills } from "../src/skills/Skills";
import { completeSlash, composeTask, parseInput, BUILTIN_COMMANDS } from "../src/protocol/slash";

const BUILTIN_DIR = path.join(__dirname, "..", "skills");
const EXPECTED = ["commit", "deps", "docs", "explain", "fix", "init", "review", "test"];

describe("built-in skills shipped with the extension", () => {
  it("all load from the skills/ folder with a description", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-noskills-"));
    const skills = loadSkills(empty, BUILTIN_DIR).filter((k) => k.builtin);
    expect(skills.map((k) => k.name).sort()).toEqual(EXPECTED);
    for (const k of skills) {
      expect(k.description.length).toBeGreaterThan(10);
      expect((k.body ?? "").length).toBeGreaterThan(200);
      expect(k.body).not.toMatch(/^---/); // frontmatter odstraněn
    }
  });

  it("/init is offered in completion and expands into the task", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-noskills-"));
    const all = [...BUILTIN_COMMANDS, ...loadSkills(empty, BUILTIN_DIR)];
    expect(completeSlash("in", all).map((c) => c.name)).toContain("init");
    const parsed = parseInput("/init", all);
    expect(parsed.skills.map((s) => s.name)).toEqual(["init"]);
    const task = composeTask(parsed);
    expect(task).toContain("### Skill /init");
    expect(task).toContain("WHISPER.md");
  });

  it("a project skill with the same name overrides the built-in one", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-override-"));
    fs.mkdirSync(path.join(root, ".whisper", "skills"), { recursive: true });
    fs.writeFileSync(path.join(root, ".whisper", "skills", "init.md"), "# init\nMůj vlastní init.\n", "utf8");
    const init = loadSkills(root, BUILTIN_DIR).find((k) => k.name === "init")!;
    expect(init.builtin).toBeFalsy();
    expect(init.body).toContain("Můj vlastní init");
  });
});
