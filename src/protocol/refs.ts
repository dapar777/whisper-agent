/**
 * Odkazy na soubory ve vstupu uživatele (jako #file v GitHub Copilotu).
 *
 *   #src/app.ts            celý soubor
 *   #src/app.ts:40-80      jen řádky 40-80
 *   #src/app.ts:120        jeden řádek s okolím
 *   #selection             aktuální výběr v editoru
 *   #file                  aktivní soubor v editoru
 *
 * Odkaz se ze zadání nevyhazuje (uživatel ho vidí v průběhu), ale obsah se přiloží
 * k promptu zvlášť, aby ho model nemusel dohledávat.
 */

export interface FileRef {
  /** celý zápis včetně # (pro zvýraznění v UI) */
  raw: string;
  /** cesta relativní k workspace; u #file / #selection prázdná */
  path: string;
  /** rozsah řádků, pokud byl zadán */
  from?: number;
  to?: number;
  /** speciální odkaz na aktivní editor */
  kind: "path" | "file" | "selection";
}

/** Kolik řádků okolo se přidá, když uživatel zadá jediný řádek (#a.ts:120). */
export const LINE_CONTEXT = 20;

// cesta smí obsahovat písmena, číslice a . _ - / \ ; končí před interpunkcí věty
const REF = /#([A-Za-z0-9._\-/\\]+)(?::(\d+)(?:\s*-\s*(\d+))?)?/g;

/** Najde všechny odkazy ve vstupu. Duplicity se odstraní, pořadí se zachová. */
export function parseRefs(input: string): FileRef[] {
  const out: FileRef[] = [];
  const seen = new Set<string>();
  for (const m of input.matchAll(REF)) {
    const token = m[1];
    const lower = token.toLowerCase();
    const kind: FileRef["kind"] = lower === "file" ? "file" : lower === "selection" || lower === "sel" ? "selection" : "path";
    // holé "#file"/"#selection" nesmí mít rozsah, jinak by šlo o cestu
    const from = m[2] ? Number(m[2]) : undefined;
    const to = m[3] ? Number(m[3]) : from;
    const key = `${kind}:${kind === "path" ? token : ""}:${from ?? ""}:${to ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ref: FileRef = { raw: m[0], path: kind === "path" ? token.replace(/\\/g, "/") : "", kind };
    if (from !== undefined) {
      ref.from = from;
      ref.to = to;
    }
    out.push(ref);
  }
  return out;
}

/** Rozsah řádků, který se má načíst (u jediného řádku s okolím). */
export function rangeFor(ref: FileRef, totalLines: number): { from: number; to: number } | undefined {
  if (ref.from === undefined) return undefined;
  const single = ref.to === undefined || ref.to === ref.from;
  const from = single ? Math.max(1, ref.from - LINE_CONTEXT) : Math.max(1, ref.from);
  const to = Math.min(totalLines, single ? ref.from + LINE_CONTEXT : Math.max(ref.from, ref.to ?? ref.from));
  return { from, to };
}

/** Text odkazu pro zobrazení (zkrácená cesta + rozsah). */
export function describeRef(ref: FileRef): string {
  if (ref.kind === "file") return "aktivní soubor";
  if (ref.kind === "selection") return "výběr v editoru";
  const range = ref.from !== undefined ? `:${ref.from}${ref.to !== undefined && ref.to !== ref.from ? "-" + ref.to : ""}` : "";
  return ref.path + range;
}
