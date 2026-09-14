/**
 * Práce s markdownem po sekcích: nahrazení celé sekce podle nadpisu a osnova dokumentu.
 * Čistá logika bez závislostí, aby šla testovat.
 */

export interface Heading {
  /** 1-based číslo řádku */
  line: number;
  level: number;
  text: string;
}

/** Nadpisy v markdownu; řádky uvnitř ohrazených bloků kódu (```) se přeskakují. */
export function findHeadings(content: string): Heading[] {
  const out: Heading[] = [];
  let fence = false;
  content.split(/\r?\n/).forEach((raw, i) => {
    const l = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(l)) {
      fence = !fence;
      return;
    }
    if (fence) return;
    const m = l.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) out.push({ line: i + 1, level: m[1].length, text: m[2] });
  });
  return out;
}

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[\s:.\-–—]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface SectionQuery {
  level?: number;
  text: string;
}

/** `## Rizika` → level 2 + "Rizika"; `Rizika` → jen text. */
export function parseSectionQuery(q: string): SectionQuery {
  const m = q.trim().match(/^(#{1,6})\s*(.*)$/);
  return m ? { level: m[1].length, text: m[2].trim() } : { text: q.trim() };
}

/** Najde sekci; při nejednoznačnosti vrátí všechny kandidáty. */
export function matchHeadings(headings: Heading[], q: SectionQuery): Heading[] {
  const want = fold(q.text);
  if (!want) return [];
  const pool = q.level ? headings.filter((h) => h.level === q.level) : headings;
  const exact = pool.filter((h) => fold(h.text) === want);
  if (exact.length) return exact;
  const starts = pool.filter((h) => fold(h.text).startsWith(want));
  if (starts.length) return starts;
  return pool.filter((h) => fold(h.text).includes(want));
}

export interface SectionResult {
  content: string;
  error?: string;
  /** co se nahradilo (1-based řádky včetně) */
  replaced?: { from: number; to: number; heading: string };
}

/**
 * Nahradí celou sekci: od nadpisu po řádek před dalším nadpisem stejné nebo vyšší úrovně
 * (nebo po konec souboru). Když náhrada začíná nadpisem, nahradí se i řádek nadpisu;
 * jinak zůstane původní nadpis a mění se jen tělo sekce.
 */
export type SectionMode = "replace" | "before" | "after";

export function applySection(original: string, query: string, replacement: string, mode: SectionMode = "replace"): SectionResult {
  const crlf = original.includes("\r\n");
  const content = original.replace(/\r\n/g, "\n");
  const lines = content.split("\n");
  const headings = findHeadings(content);
  const q = parseSectionQuery(query);
  const hits = matchHeadings(headings, q);
  const list = (hs: Heading[]) => hs.map((h) => `  L${h.line}: ${"#".repeat(h.level)} ${h.text}`).join("\n");
  if (hits.length === 0) {
    return {
      content: original,
      error: headings.length
        ? `Section "${query}" not found. Headings in the file:\n${list(headings)}`
        : `Section "${query}" not found: the file has no markdown headings (use SEARCH/REPLACE hunks instead).`,
    };
  }
  if (hits.length > 1) {
    return { content: original, error: `Section "${query}" is ambiguous, ${hits.length} headings match. Use the exact text or add the level (e.g. "### ${hits[0].text}"):\n${list(hits)}` };
  }
  const h = hits[0];
  const startIdx = h.line - 1;
  let endIdx = lines.length; // exclusive
  for (const other of headings) {
    if (other.line > h.line && other.level <= h.level) {
      endIdx = other.line - 1;
      break;
    }
  }
  // konec sekce: nechat oddělovací prázdné řádky před dalším nadpisem mimo nahrazovaný úsek
  let bodyEnd = endIdx;
  while (bodyEnd > startIdx + 1 && lines[bodyEnd - 1].trim() === "") bodyEnd--;

  let repl = replacement.replace(/\r\n/g, "\n").replace(/^\n+/, "").replace(/\s+$/, "");
  const label = `${"#".repeat(h.level)} ${h.text}`;
  const finish = (out: string, from: number, to: number): SectionResult => ({ content: crlf ? out.replace(/\n/g, "\r\n") : out, replaced: { from, to, heading: label } });

  if (mode === "before" || mode === "after") {
    // vložení nové sekce (tělo musí začínat nadpisem, jinak by srostla se sousední sekcí)
    const firstLine = repl.split("\n").find((l) => l.trim() !== "") ?? "";
    if (!/^#{1,6}\s/.test(firstLine)) {
      return { content: original, error: `insert="${mode}" needs a body that starts with a heading line (e.g. "## Testování"), so the new section stays separate from "${label}".` };
    }
    const at = mode === "before" ? startIdx : bodyEnd;
    const before = lines.slice(0, at);
    const after = lines.slice(at);
    // před vloženou sekcí i za ní právě jeden prázdný řádek
    while (before.length && before[before.length - 1].trim() === "") before.pop();
    const lead = before.length ? [""] : [];
    const gapAfter = after.length && after[0].trim() !== "" ? [""] : [];
    const out = [...before, ...lead, ...repl.split("\n"), ...gapAfter, ...after].join("\n");
    const insertedAt = before.length + lead.length + 1;
    return finish(out, insertedAt, insertedAt + repl.split("\n").length - 1);
  }

  const firstLine = repl.split("\n").find((l) => l.trim() !== "") ?? "";
  const keepHeading = !/^#{1,6}\s/.test(firstLine);
  const newLines = (keepHeading ? [lines[startIdx], "", ...(repl ? repl.split("\n") : [])] : repl.split("\n"));
  const before = lines.slice(0, startIdx);
  const after = lines.slice(bodyEnd);
  // mezi novou sekcí a další zachovat právě jeden prázdný řádek
  const gap = after.length && after[0].trim() !== "" ? [""] : [];
  const out = [...before, ...newLines, ...gap, ...after].join("\n");
  return finish(out, h.line, bodyEnd);
}

/**
 * Osnova souboru pro model, když je soubor příliš dlouhý na jeden <read>:
 * markdown = nadpisy, kód = deklarace na začátku řádku. Max `max` položek.
 */
export function outline(content: string, path: string, max = 80): string {
  const isMd = /\.(md|markdown|txt|rst)$/i.test(path);
  const items: string[] = [];
  if (isMd) {
    for (const h of findHeadings(content)) items.push(`L${h.line}: ${"#".repeat(h.level)} ${h.text}`);
  } else {
    const decl = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class|interface|type|enum|namespace|const|let|var|def|fn|pub(?:\([^)]*\))?\s+fn|func|struct|impl|trait|public\s+(?:static\s+)?(?:class|interface|void|[A-Z]\w*)|private\s+class|protected\s+class|abstract\s+class|module|package)\b\s*([A-Za-z_$][\w$]*)?/;
    content.split(/\r?\n/).forEach((l, i) => {
      if (/^\s/.test(l)) return;
      const m = l.match(decl);
      if (m) items.push(`L${i + 1}: ${l.trim().slice(0, 90)}`);
    });
  }
  if (!items.length) return "";
  const shown = items.slice(0, max);
  return shown.join("\n") + (items.length > max ? `\n… (${items.length - max} more)` : "");
}
