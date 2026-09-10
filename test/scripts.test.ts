import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runCommandFor, saveScript, scriptExtension } from "../src/skills/Scripts";
import { loadSkills } from "../src/skills/Skills";
import { parseReply } from "../src/protocol/ResponseParser";
import { buildProtocolSpec } from "../src/protocol/PromptBuilder";

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

describe("script suggestions", () => {
  it("derives the extension from lang, shebang or the code itself", () => {
    expect(scriptExtension("print(1)", "python")).toBe(".py");
    expect(scriptExtension("x", "PowerShell")).toBe(".ps1");
    expect(scriptExtension("#!/usr/bin/env node\nconsole.log(1)")).toBe(".js");
    expect(scriptExtension("#!/bin/bash\necho hi")).toBe(".sh");
    expect(scriptExtension("import os\ndef main():\n  pass")).toBe(".py");
    expect(scriptExtension("@echo off\nrem hello")).toBe(".cmd");
  });

  it("saves a runnable file, adds a shebang and reports how to run it", () => {
    const root = tmp("whisper-script-");
    const saved = saveScript(root, "Release check", "import sys\nprint('ok')\n", { lang: "python" });
    expect(saved.rel).toBe(".whisper/scripts/release-check.py");
    expect(saved.command).toBe("python .whisper/scripts/release-check.py");
    const content = fs.readFileSync(saved.absolute, "utf8");
    expect(content.startsWith("#!/usr/bin/env python3\n")).toBe(true);
    expect(content).toContain("print('ok')");
    expect(content.endsWith("\n")).toBe(true);
  });

  it("honours an explicit file name and never doubles a shebang", () => {
    const root = tmp("whisper-script-");
    const saved = saveScript(root, "anything", "#!/usr/bin/env bash\necho hi", { file: "deploy.sh" });
    expect(path.basename(saved.absolute)).toBe("deploy.sh");
    expect(saved.command).toBe("bash .whisper/scripts/deploy.sh");
    expect(fs.readFileSync(saved.absolute, "utf8").match(/#!/g)).toHaveLength(1);
  });

  it("run commands cover the usual interpreters", () => {
    expect(runCommandFor("a/b.js")).toBe("node a/b.js");
    expect(runCommandFor("a/b.ps1")).toContain("powershell");
    expect(runCommandFor("a/b.cmd")).toBe("a/b.cmd");
  });

  it("the protocol spec offers the script kind so the model knows about it", () => {
    const spec = buildProtocolSpec();
    expect(spec).toContain("skill | script | whisper | rule | hook");
    expect(spec).toContain("runnable script");
    const parsed = parseReply('<whisper turn="1">\n<suggest kind="script" lang="python" file="x.py" title="T">print(1)</suggest>\n</whisper>');
    expect(parsed.errors).toEqual([]);
    expect(parsed.actions[0].attrs).toMatchObject({ kind: "script", lang: "python", file: "x.py" });
  });
});

describe("skills that ship scripts", () => {
  it("lists a skill's own scripts with a ready-to-run command", () => {
    const root = tmp("whisper-skilldir-");
    const dir = path.join(root, ".whisper", "skills", "release");
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "# release\nVydá novou verzi.\n", "utf8");
    fs.writeFileSync(path.join(dir, "scripts", "bump.py"), "print(1)", "utf8");
    fs.writeFileSync(path.join(dir, "helper.sh"), "echo hi", "utf8");
    fs.writeFileSync(path.join(dir, "notes.md"), "not a script", "utf8");

    const skill = loadSkills(root).find((k) => k.name === "release")!;
    expect(skill.body).toContain("## Scripts shipped with this skill");
    expect(skill.body).toContain("python .whisper/skills/release/scripts/bump.py");
    expect(skill.body).toContain("bash .whisper/skills/release/helper.sh");
    expect(skill.body).not.toContain("notes.md");
  });

  it("a single-file skill without scripts gets no scripts section", () => {
    const root = tmp("whisper-skillflat-");
    fs.mkdirSync(path.join(root, ".whisper", "skills"), { recursive: true });
    fs.writeFileSync(path.join(root, ".whisper", "skills", "plain.md"), "# plain\nJen text.\n", "utf8");
    const skill = loadSkills(root).find((k) => k.name === "plain")!;
    expect(skill.body).not.toContain("Scripts shipped");
  });

  it("the shipped built-in skills really carry runnable scripts", () => {
    const empty = tmp("whisper-builtin-");
    const skills = loadSkills(empty, path.join(__dirname, "..", "skills"));
    for (const name of ["review", "deps"]) {
      const skill = skills.find((k) => k.name === name)!;
      expect(skill.body).toContain("## Scripts shipped with this skill");
      const file = skill.body!.match(/python (\S+\.py)/)![1];
      expect(fs.existsSync(file)).toBe(true);
    }
  });
});
