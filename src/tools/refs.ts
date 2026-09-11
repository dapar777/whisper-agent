import { Host } from "../host/Host";
import { describeRef, FileRef, parseRefs, rangeFor } from "../protocol/refs";

/** Jeden vyřešený odkaz i s obsahem, připravený do promptu. */
export interface ResolvedRef {
  label: string;
  path: string;
  /** očíslovaný obsah, nebo chybová hláška */
  content: string;
  ok: boolean;
  lines?: string;
}

/** Aktivní editor: co je otevřené a co je vybrané (pro #file a #selection). */
export interface EditorContext {
  path?: string;
  selection?: string;
  selectionRange?: string;
}

const MAX_CHARS = 60_000;

/**
 * Načte obsah pro odkazy `#soubor`, `#soubor:od-do`, `#file` a `#selection`.
 * Neexistující cesta se nahlásí jako chyba u konkrétního odkazu, zbytek se načte dál.
 */
export async function resolveRefs(host: Host, input: string, editor?: EditorContext): Promise<ResolvedRef[]> {
  const refs = parseRefs(input);
  if (!refs.length) return [];
  const out: ResolvedRef[] = [];
  let budget = MAX_CHARS;

  for (const ref of refs) {
    const resolved = await resolveOne(host, ref, editor, budget);
    if (!resolved) continue;
    budget -= resolved.content.length;
    out.push(resolved);
    if (budget <= 0) break;
  }
  return out;
}

async function resolveOne(host: Host, ref: FileRef, editor: EditorContext | undefined, budget: number): Promise<ResolvedRef | undefined> {
  const label = describeRef(ref);

  if (ref.kind === "selection") {
    if (!editor?.selection) {
      return { label, path: editor?.path ?? "", ok: false, content: "(v editoru není nic vybráno)" };
    }
    return { label, path: editor.path ?? "", ok: true, lines: editor.selectionRange, content: editor.selection };
  }

  const path = ref.kind === "file" ? editor?.path : ref.path;
  if (!path) return { label, path: "", ok: false, content: "(v editoru není otevřený žádný soubor z tohoto projektu)" };

  try {
    host.assertInside(path);
  } catch {
    return { label, path, ok: false, content: "(cesta leží mimo workspace)" };
  }
  if (!(await host.exists(path))) {
    // častý překlep: uživatel napsal jen název souboru
    const base = path.split("/").pop() ?? path;
    const hits = (await host.listFiles("**/" + base, 20)).slice(0, 5);
    const hint = hits.length ? " Podobné: " + hits.join(", ") : "";
    return { label, path, ok: false, content: `(soubor neexistuje)${hint}` };
  }

  let text: string;
  try {
    text = await host.readFile(path);
  } catch (e) {
    return { label, path, ok: false, content: `(soubor nelze přečíst: ${(e as Error).message})` };
  }
  const all = text.split(/\r?\n/);
  const range = rangeFor(ref, all.length);
  const from = range?.from ?? 1;
  const to = range?.to ?? all.length;
  const width = String(to).length;
  let body = all
    .slice(from - 1, to)
    .map((l, i) => `${String(from + i).padStart(width)}| ${l}`)
    .join("\n");
  if (body.length > budget) body = body.slice(0, Math.max(0, budget)) + "\n… (zkráceno, vyžádej si zbytek přes <read>)";
  return { label, path, ok: true, lines: range ? `${from}-${to}` : `1-${all.length}`, content: body };
}

/** Blok do promptu; prázdný řetězec, když uživatel nic neodkázal. */
export function renderRefs(refs: ResolvedRef[]): string {
  if (!refs.length) return "";
  const parts = ["## Files the user referenced (with #) — read them before asking for more", ""];
  for (const r of refs) {
    const head = `### ${r.label}${r.path && r.label !== r.path ? ` (${r.path}${r.lines ? ":" + r.lines : ""})` : ""}`;
    parts.push(head, "", r.ok ? r.content : r.content, "");
  }
  return parts.join("\n");
}
