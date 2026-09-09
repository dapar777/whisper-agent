import { describe, expect, it } from "vitest";
import { BUILTIN_COMMANDS, completeSlash, composeTask, parseInput, parseSkillFile, SlashCommand } from "../src/protocol/slash";

const skill: SlashCommand = { name: "review", kind: "skill", description: "Code review", body: "# review\nCheck everything." };
const all = [...BUILTIN_COMMANDS, skill];

describe("slash", () => {
  it("parses leading builtin commands and skills, keeps the rest as text", () => {
    const p = parseInput("/plan /review Přidej validaci\ndruhý řádek", all);
    expect(p.commands).toEqual(["plan"]);
    expect(p.skills.map((s) => s.name)).toEqual(["review"]);
    expect(p.text).toBe("Přidej validaci\ndruhý řádek");
    expect(p.unknown).toEqual([]);
  });

  it("reports unknown commands and ignores slashes inside the text", () => {
    const p = parseInput("/nope oprav cestu /usr/bin", all);
    expect(p.unknown).toEqual(["nope"]);
    expect(p.text).toBe("oprav cestu /usr/bin");
  });

  it("composes the task with skill instructions", () => {
    const p = parseInput("/review src/a.ts", all);
    const task = composeTask(p);
    expect(task).toContain("src/a.ts");
    expect(task).toContain("### Skill /review");
    expect(task).toContain("Check everything.");
  });

  it("completes by prefix with builtins first", () => {
    expect(completeSlash("", all).map((c) => c.name)).toEqual(["auto", "help", "plan", "resend", "stop", "suggest", "undo", "review"]);
    expect(completeSlash("re", all).map((c) => c.name)).toEqual(["resend", "review"]);
  });

  it("parses SKILL.md frontmatter and plain markdown", () => {
    const fm = parseSkillFile('---\nname: Place Research\ndescription: "Rešerše místa"\n---\n# Playbook\nkroky', "x");
    expect(fm).toEqual({ name: "place-research", description: "Rešerše místa", body: "# Playbook\nkroky" });
    const plain = parseSkillFile("# lint-fix\nSpusť lint a oprav.\n\nDetaily", "fallback");
    expect(plain.name).toBe("lint-fix");
    expect(plain.description).toBe("Spusť lint a oprav.");
  });
});
