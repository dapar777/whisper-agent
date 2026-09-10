import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseSkillFile, SlashCommand } from "../protocol/slash";

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
        out.push({ name: parsed.name, kind: "skill", description: parsed.description || "(skill)", body: parsed.body, source: file, builtin: src.builtin });
      } catch {
        /* nečitelný skill přeskočíme */
      }
    }
  }
  return out;
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
