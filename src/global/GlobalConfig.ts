import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Globální (uživatelská) konfigurace agenta v ~/.whisper: platí ve všech projektech.
 *  - WHISPER.md        globální instrukce (přidávají se do každé preambule)
 *  - rules.md          pravidla chování agenta (jedno na řádek, přidávají se k pravidlům preambule)
 *  - hooks.json        globální hooky {"afterChange":[...]}
 *  - skills/           globální skilly
 *  - agent-feedback.md podněty na úpravu samotného agenta (pro vývojáře)
 */
export const GLOBAL_DIR = path.join(os.homedir(), ".whisper");

function readIfExists(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function appendTo(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = readIfExists(file);
  fs.writeFileSync(file, current.trimEnd() + (current.trim() ? "\n" : "") + text.trim() + "\n", "utf8");
}

export function readGlobalInstructions(): string {
  return readIfExists(path.join(GLOBAL_DIR, "WHISPER.md")).trim();
}

export function appendGlobalInstructions(text: string): void {
  appendTo(path.join(GLOBAL_DIR, "WHISPER.md"), text);
}

/** Pravidla jako seznam řádků (bez prázdných a komentářů). */
export function readGlobalRules(): string[] {
  return readIfExists(path.join(GLOBAL_DIR, "rules.md"))
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
    .filter((l) => l && !l.startsWith("#"));
}

export function appendGlobalRule(rule: string): void {
  const one = rule.replace(/\s+/g, " ").trim();
  if (readGlobalRules().includes(one)) return;
  appendTo(path.join(GLOBAL_DIR, "rules.md"), `- ${one}`);
}

export function readGlobalHooks(): { match: string; run: string; cwd?: string }[] {
  try {
    const data = JSON.parse(readIfExists(path.join(GLOBAL_DIR, "hooks.json")) || "{}") as { afterChange?: { match: string; run: string; cwd?: string }[] };
    return (data.afterChange ?? []).filter((h) => h && typeof h.match === "string" && typeof h.run === "string");
  } catch {
    return [];
  }
}

export function addGlobalHook(hook: { match: string; run: string; cwd?: string }): void {
  const hooks = readGlobalHooks();
  if (hooks.some((h) => h.match === hook.match && h.run === hook.run)) return;
  hooks.push(hook);
  fs.mkdirSync(GLOBAL_DIR, { recursive: true });
  fs.writeFileSync(path.join(GLOBAL_DIR, "hooks.json"), JSON.stringify({ afterChange: hooks }, null, 2) + "\n", "utf8");
}

/** Podnět na úpravu agenta samotného; vývojář ho čte v ~/.whisper/agent-feedback.md. */
export function appendAgentFeedback(title: string, body: string, project: string): void {
  appendTo(path.join(GLOBAL_DIR, "agent-feedback.md"), `## ${new Date().toISOString().slice(0, 10)} · ${title} (${project})\n\n${body.trim()}\n`);
}

export function globalSkillsDir(): string {
  return path.join(GLOBAL_DIR, "skills");
}
