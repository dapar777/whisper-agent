/**
 * Čistá logika SEARCH/REPLACE úprav (bez závislosti na vscode), aby šla testovat.
 */

export interface Hunk {
  search: string;
  replace: string;
}

export interface ApplyResult {
  content: string;
  applied: number;
  failures: { hunk: number; reason: string }[];
}

const HUNK_RE = /<{5,}\s*SEARCH[^\n]*\n([\s\S]*?)\n?={5,}[^\n]*\n([\s\S]*?)\n?>{5,}\s*REPLACE[^\n]*/g;

export function parseHunks(body: string): Hunk[] {
  const hunks: Hunk[] = [];
  const src = body.replace(/\r\n/g, "\n");
  HUNK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HUNK_RE.exec(src))) {
    hunks.push({ search: m[1], replace: m[2] });
  }
  return hunks;
}

function normalizeLine(l: string): string {
  return l.replace(/\s+/g, " ").trim();
}

interface Loc {
  start: number;
  end: number;
  mode: "exact" | "ws";
}

/** Najde shodu v `content`: nejdřív přesně, pak s tolerancí bílých znaků po řádcích. */
function locate(content: string, search: string): Loc | null {
  if (search.length === 0) return null;
  const exact = content.indexOf(search);
  if (exact >= 0) return { start: exact, end: exact + search.length, mode: "exact" };

  const lines = content.split("\n");
  const sLines = search.split("\n").map(normalizeLine);
  while (sLines.length && sLines[0] === "") sLines.shift();
  while (sLines.length && sLines[sLines.length - 1] === "") sLines.pop();
  if (sLines.length === 0) return null;

  const offsets: number[] = [];
  let acc = 0;
  for (const l of lines) {
    offsets.push(acc);
    acc += l.length + 1;
  }
  for (let i = 0; i + sLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < sLines.length; j++) {
      if (normalizeLine(lines[i + j]) !== sLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const lastIdx = i + sLines.length - 1;
      return { start: offsets[i], end: offsets[lastIdx] + lines[lastIdx].length, mode: "ws" };
    }
  }
  return null;
}

/** Pro chybové hlášení: nejbližší kandidát podle prvního „nosného“ řádku SEARCH. */
function nearest(content: string, search: string): string {
  const first = search.split("\n").map(normalizeLine).find((l) => l.length > 3);
  if (!first) return "";
  const lines = content.split("\n");
  const i = lines.findIndex((l) => normalizeLine(l).includes(first));
  if (i < 0) return "";
  const from = Math.max(0, i - 2);
  const to = Math.min(lines.length, i + 4);
  return lines
    .slice(from, to)
    .map((l, k) => `${from + k + 1}| ${l}`)
    .join("\n");
}

/** Při shodě s tolerancí bílých znaků přenese odsazení originálu na náhradu. */
function reindent(original: string, replacement: string): string {
  const origIndent = original.match(/^[ \t]*/)?.[0] ?? "";
  const replIndent = replacement.match(/^[ \t]*/)?.[0] ?? "";
  if (origIndent === replIndent) return replacement;
  return replacement
    .split("\n")
    .map((l) => (l.startsWith(replIndent) ? origIndent + l.slice(replIndent.length) : l))
    .join("\n");
}

export function applyHunks(original: string, hunks: Hunk[]): ApplyResult {
  const crlf = original.includes("\r\n");
  let content = original.replace(/\r\n/g, "\n");
  const failures: ApplyResult["failures"] = [];
  let applied = 0;
  hunks.forEach((h, n) => {
    const search = h.search.replace(/\r\n/g, "\n");
    let replace = h.replace.replace(/\r\n/g, "\n");
    const loc = locate(content, search);
    if (!loc) {
      const near = nearest(content, search);
      failures.push({ hunk: n + 1, reason: `SEARCH text not found.${near ? ` Closest match:\n${near}` : ""}` });
      return;
    }
    if (loc.mode === "ws") replace = reindent(content.slice(loc.start, loc.end), replace);
    content = content.slice(0, loc.start) + replace + content.slice(loc.end);
    applied++;
  });
  return { content: crlf ? content.replace(/\n/g, "\r\n") : content, applied, failures };
}
