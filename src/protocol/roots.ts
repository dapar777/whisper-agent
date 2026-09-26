import * as path from "path";

/**
 * Cesty ve workspace s více kořenovými složkami (multi-root). Dřív se všechno vztahovalo k první
 * složce: strom, čtení, zápis i grep, takže kód v dalších složkách model neviděl a cesty do nich
 * padaly na „mimo workspace“. Teď je každá složka adresář nejvyšší úrovně pojmenovaný podle svého
 * názvu ve workspace: `app/src/x.ts`, `lib/README.md`. Jediná složka zůstává bez předpony (zpětně
 * kompatibilní). Stav agenta (`.whisper/`) je vždy v první složce.
 *
 * Bez závislosti na VS Code, aby šla logika testovat.
 */

export interface RootFolder {
  /** název, kterým cesty začínají (jedinečný v rámci workspace) */
  name: string;
  fsPath: string;
}

export const STATE_DIR = ".whisper";

/** Názvy složek musí být jedinečné: druhý `app` se stane `app-2`. */
export function uniqueRoots(folders: { name: string; fsPath: string }[]): RootFolder[] {
  const seen = new Map<string, number>();
  return folders.map((f) => {
    const base = f.name.replace(/[\\/]/g, "_") || "root";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { name: n === 1 ? base : `${base}-${n}`, fsPath: f.fsPath };
  });
}

function clean(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Uvnitř složky: absolutní cesta nesmí utéct nad její kořen. */
function inside(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const back = path.relative(root, abs);
  if (back.startsWith("..") || path.isAbsolute(back)) throw new Error(`Cesta "${rel}" leží mimo workspace.`);
  return abs;
}

/**
 * Relativní cesta → absolutní. Jedna složka: relativně k ní. Více složek: první segment je název
 * složky; `.whisper/...` patří do první složky; cokoli jiného je chyba s nápovědou, jak cesty psát.
 */
export function resolveRel(rel: string, roots: RootFolder[]): { fsPath: string; folder: RootFolder; inside: string } {
  if (!roots.length) throw new Error("Není otevřený žádný workspace.");
  const c = clean(rel);
  if (roots.length === 1) return { fsPath: inside(roots[0].fsPath, c), folder: roots[0], inside: c };
  const [head, ...rest] = c.split("/");
  const tail = rest.join("/");
  if (head === STATE_DIR || c === "" || c === ".") return { fsPath: inside(roots[0].fsPath, c), folder: roots[0], inside: c };
  const folder = roots.find((r) => r.name === head);
  if (!folder) {
    throw new Error(
      `Cesta "${rel}" nezačíná názvem složky workspace. Workspace má více složek, cesty začínají jejich názvem: ` +
        roots.map((r) => `${r.name}/…`).join(", ") +
        ".",
    );
  }
  return { fsPath: inside(folder.fsPath, tail), folder, inside: tail };
}

/** Absolutní cesta → relativní ve workspace (s předponou složky u multi-root); undefined = mimo. */
export function relOf(fsPath: string, roots: RootFolder[]): string | undefined {
  const norm = path.resolve(fsPath);
  // nejdelší shodný kořen vyhrává (složka uvnitř jiné složky)
  const match = roots
    .map((r) => ({ r, rel: path.relative(r.fsPath, norm) }))
    .filter(({ rel }) => rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel))
    .sort((a, b) => b.r.fsPath.length - a.r.fsPath.length)[0];
  if (!match) return undefined;
  const rel = match.rel.replace(/\\/g, "/");
  return roots.length === 1 ? rel : `${match.r.name}/${rel}`;
}

/**
 * Glob pro hledání: u multi-root může začínat názvem složky (`app/src/**`), pak se hledá jen v ní
 * se zbytkem globu; jinak (`**\/*.ts`) ve všech složkách. Vrací dvojice (složka, glob v ní).
 */
export function splitGlob(glob: string, roots: RootFolder[]): { folder: RootFolder; glob: string }[] {
  const g = clean(glob);
  if (roots.length <= 1) return roots.map((folder) => ({ folder, glob: g }));
  const [head, ...rest] = g.split("/");
  const folder = roots.find((r) => r.name === head);
  if (folder && rest.length) return [{ folder, glob: rest.join("/") }];
  if (folder) return [{ folder, glob: "**/*" }];
  return roots.map((f) => ({ folder: f, glob: g }));
}

/** Popis složek do promptu. */
export function describeRoots(roots: RootFolder[]): string[] {
  return roots.map((r) => `${r.name}/ → ${r.fsPath}`);
}
