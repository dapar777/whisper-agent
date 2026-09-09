/** Lomítkové příkazy ve vstupu (čistá logika, bez vscode). */

export interface SlashCommand {
  name: string;
  description: string;
  /** vestavěný příkaz vs. skill z disku */
  kind: "builtin" | "skill";
  /** tělo skillu (instrukce pro model) */
  body?: string;
  /** odkud skill pochází (cesta) */
  source?: string;
}

export const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "plan", kind: "builtin", description: "Režim PLAN: model založí a udržuje checklist úkolů" },
  { name: "suggest", kind: "builtin", description: "Navrhnout skilly, hooky, povolení a úkoly z dosavadního průběhu" },
  { name: "auto", kind: "builtin", description: "Přepnout schvalování příkazů: auto / ptát se" },
  { name: "resend", kind: "builtin", description: "Znovu poslat kontext do nového chatu" },
  { name: "undo", kind: "builtin", description: "Vrátit poslední kolo (git checkpoint)" },
  { name: "stop", kind: "builtin", description: "Zrušit běžící úkol" },
  { name: "help", kind: "builtin", description: "Nápověda k příkazům a stavům" },
];

export interface ParsedInput {
  /** vestavěné příkazy nalezené na začátku vstupu */
  commands: string[];
  /** použité skilly (v pořadí) */
  skills: SlashCommand[];
  /** zbytek textu (zadání) */
  text: string;
  /** neznámé /příkazy */
  unknown: string[];
}

/**
 * Rozebere vstup: `/plan /muj-skill Přidej validaci` → commands=[plan], skills=[muj-skill], text="Přidej validaci".
 * Lomítka se berou jen na začátku vstupu (oddělená mezerami nebo novými řádky).
 */
export function parseInput(input: string, available: SlashCommand[]): ParsedInput {
  const out: ParsedInput = { commands: [], skills: [], text: "", unknown: [] };
  let rest = input.trim();
  const byName = new Map(available.map((c) => [c.name.toLowerCase(), c]));
  while (rest.startsWith("/")) {
    const m = rest.match(/^\/([\w][\w.-]*)\s*/);
    if (!m) break;
    const cmd = byName.get(m[1].toLowerCase());
    if (!cmd) {
      out.unknown.push(m[1]);
    } else if (cmd.kind === "builtin") {
      out.commands.push(cmd.name);
    } else {
      out.skills.push(cmd);
    }
    rest = rest.slice(m[0].length);
  }
  out.text = rest.trim();
  return out;
}

/** Návrhy pro doplňování: prefix bez lomítka → seřazené příkazy. */
export function completeSlash(prefix: string, available: SlashCommand[]): SlashCommand[] {
  const p = prefix.toLowerCase();
  return available
    .filter((c) => c.name.toLowerCase().startsWith(p))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "builtin" ? -1 : 1))
    .slice(0, 12);
}

/** Složí zadání pro model z textu a použitých skillů. */
export function composeTask(parsed: ParsedInput): string {
  if (parsed.skills.length === 0) return parsed.text;
  const blocks = parsed.skills.map((s) => `### Skill /${s.name}\n${(s.body ?? "").trim()}`);
  return [parsed.text || "(follow the skill instructions)", "", "Apply these skill instructions:", "", ...blocks].join("\n");
}

/** Jednoduchý parser frontmatteru SKILL.md (name/description). */
export function parseSkillFile(content: string, fallbackName: string): { name: string; description: string; body: string } {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  let name = fallbackName;
  let description = "";
  let body = content;
  if (fm) {
    body = content.slice(fm[0].length);
    for (const line of fm[1].split(/\r?\n/)) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (!kv) continue;
      if (kv[1] === "name") name = kv[2].trim().replace(/^["']|["']$/g, "");
      if (kv[1] === "description") description = kv[2].trim().replace(/^["']|["']$/g, "");
    }
  } else {
    const h = content.match(/^#\s+(.+)$/m);
    if (h) name = h[1].trim().replace(/^\//, "");
    const firstLine = content.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#"));
    description = firstLine?.trim() ?? "";
  }
  return { name: name.toLowerCase().replace(/\s+/g, "-"), description: description.slice(0, 160), body: body.trim() };
}
