import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseSkillFile, SlashCommand } from "../protocol/slash";
import { runCommandFor } from "./Scripts";

/**
 * Skilly dostupné přes /název. Whisper je nezávislý na jiných nástrojích, hledá jen ve svých adresářích:
 *  - <workspace>/.whisper/skills/*.md      (skilly projektu, včetně návrhů schválených v agentovi)
 *  - <workspace>/.whisper/skills/*\/SKILL.md (skill s vlastním adresářem)
 *  - ~/.whisper/skills/*.md a ~/.whisper/skills/*\/SKILL.md (skilly uživatele)
 */
/**
 * Načte skilly: projektové (.whisper/skills), uživatelské (~/.whisper/skills) a vestavěné
 * (složka `skills/` dodávaná s rozšířením: /init, /commit, /review, /test, /fix, /explain, /docs, /deps).
 * Při shodě jména vyhrává projekt, pak uživatel, vestavěný lze tedy přepsat.
 */
export function loadSkills(workspaceRoot: string, builtinDir?: string): SlashCommand[] {
  const home = os.homedir();
  const sources: { dir: string; nested: boolean; builtin?: boolean }[] = [
    { dir: path.join(workspaceRoot, ".whisper", "skills"), nested: false },
    { dir: path.join(workspaceRoot, ".whisper", "skills"), nested: true },
    { dir: path.join(home, ".whisper", "skills"), nested: false },
    { dir: path.join(home, ".whisper", "skills"), nested: true },
  ];
  if (builtinDir) sources.push({ dir: builtinDir, nested: true, builtin: true }, { dir: builtinDir, nested: false, builtin: true });
  const seen = new Set<string>();
  const out: SlashCommand[] = [];
  for (const src of sources) {
    for (const file of listSkillFiles(src.dir, src.nested)) {
      try {
        const content = fs.readFileSync(file, "utf8");
        const fallback = src.nested ? path.basename(path.dirname(file)) : path.basename(file, ".md");
        const parsed = parseSkillFile(content, fallback);
        if (!parsed.name || seen.has(parsed.name)) continue;
        seen.add(parsed.name);
        const body = parsed.body + describeSkillScripts(file, workspaceRoot);
        out.push({ name: parsed.name, kind: "skill", description: parsed.description || "(skill)", body, source: file, builtin: src.builtin });
      } catch {
        /* nečitelný skill přeskočíme */
      }
    }
  }
  return out;
}

/** Přípony, které se u skillu berou jako spustitelné skripty. */
const SCRIPT_EXT = /\.(py|js|mjs|cjs|ts|sh|ps1|cmd|bat|rb|pl)$/i;

/**
 * Skill uložený jako adresář (`název/SKILL.md`) může vedle playbooku nést i skripty.
 * Ty se vypíšou do těla skillu i s příkazem ke spuštění, aby o nich model věděl.
 */
function describeSkillScripts(skillFile: string, workspaceRoot: string): string {
  const dir = path.dirname(skillFile);
  if (path.basename(skillFile).toLowerCase() !== "skill.md") return "";
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => SCRIPT_EXT.test(n));
  } catch {
    return "";
  }
  // skripty mohou být i v podsložce scripts/
  try {
    for (const n of fs.readdirSync(path.join(dir, "scripts")).filter((n) => SCRIPT_EXT.test(n))) names.push(path.join("scripts", n));
  } catch {
    /* podsložka scripts/ nemusí existovat */
  }
  if (!names.length) return "";
  const lines = names.sort().map((n) => {
    const abs = path.join(dir, n);
    const rel = abs.startsWith(workspaceRoot) ? path.relative(workspaceRoot, abs).replace(/\\/g, "/") : abs.replace(/\\/g, "/");
    return `- \`${runCommandFor(rel)}\``;
  });
  return [
    "",
    "",
    "## Scripts shipped with this skill",
    "",
    "Run them with <run> instead of writing the same code again (`--help` where available):",
    ...lines,
  ].join("\n");
}

function listSkillFiles(dir: string, nested: boolean): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const e of entries) {
    if (nested) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const candidate = path.join(dir, e.name, "SKILL.md");
      if (fs.existsSync(candidate)) files.push(candidate);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      files.push(path.join(dir, e.name));
    }
  }
  return files.sort();
}

/** Uloží nový skill (schválený návrh) do <workspace>/.whisper/skills/<name>.md, nebo globálně do ~/.whisper/skills/. */
export function saveSkill(workspaceRoot: string, name: string, body: string, global = false): string {
  const dir = global ? path.join(os.homedir(), ".whisper", "skills") : path.join(workspaceRoot, ".whisper", "skills");
  fs.mkdirSync(dir, { recursive: true });
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
  const file = path.join(dir, `${slug}.md`);
  const content = body.trim().startsWith("#") ? body.trim() : `# ${slug}\n\n${body.trim()}`;
  fs.writeFileSync(file, content + "\n", "utf8");
  return file;
}
