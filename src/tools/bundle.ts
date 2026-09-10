import { Host } from "../host/Host";
import { ActionResult } from "../protocol/schema";
import { globToRegExp } from "../protocol/text";

/** První řádek svazku; podle něj se pozná, že text ve schránce je náš (ne odpověď modelu). */
export const BUNDLE_MARKER = "# Whisper Agent bundle";

const DEFAULT_MAX_CHARS = 400_000;
const MAX_FILE_CHARS = 200_000;
const BINARY_EXT = /\.(png|jpe?g|gif|bmp|ico|webp|svgz|pdf|zip|gz|tgz|7z|rar|jar|exe|dll|so|dylib|bin|dat|db|sqlite|woff2?|ttf|otf|eot|mp[34]|wav|ogg|mov|avi|lock)$/i;

/** Jedna sekce svazku: hlavička, číslované řádky, patička. */
function renderFile(p: string, text: string): string {
  const lines = text.split(/\r?\n/);
  const width = String(lines.length).length;
  return [`===== FILE: ${p} (${lines.length} lines) =====`, ...lines.map((l, i) => `${String(i + 1).padStart(width)}| ${l}`), `===== END FILE: ${p} =====`].join("\n");
}

interface Picked {
  path: string;
  text: string;
  lines: number;
}

/**
 * <bundle>: spojí více souborů (seznam cest/globů nebo celou codebase) do jednoho
 * strukturovaného textového souboru v .whisper/out/, který se přiloží k dalšímu promptu.
 * Každý soubor má hlavičku, číslované řádky a patičku, na začátku je obsah svazku.
 */
export async function toolBundle(host: Host, attrs: Record<string, string>, turn: number, index: number): Promise<ActionResult> {
  const maxChars = Math.min(2_000_000, Math.max(20_000, Number(attrs.maxChars) || DEFAULT_MAX_CHARS));
  const all = attrs.all === "true" || attrs.all === "1";
  const patterns = (attrs.paths ?? "")
    .split(/[\n,]/)
    .map((p) => p.trim().replace(/\\/g, "/"))
    .filter(Boolean);
  if (!all && patterns.length === 0) {
    return { tool: "bundle", attrs, status: "error", output: 'Give paths="a.ts, src/**/*.py" (comma-separated paths or globs) or all="true".' };
  }

  // výběr souborů: přesné cesty, globy a adresáře; respektuje .gitignore a výchozí výluky přes host.listFiles
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    if (!seen.has(p)) {
      seen.add(p);
      candidates.push(p);
    }
  };
  if (all) {
    for (const f of await host.listFiles("**/*", 20_000)) add(f);
  } else {
    const allFiles = await host.listFiles("**/*", 20_000);
    for (const pat of patterns) {
      if (/[*?{[]/.test(pat)) {
        const re = globToRegExp(pat);
        for (const f of allFiles) if (re.test(f)) add(f);
      } else if (await host.exists(pat)) {
        const asDir = allFiles.filter((f) => f.startsWith(pat.replace(/\/+$/, "") + "/"));
        if (asDir.length) for (const f of asDir) add(f);
        else add(pat);
      }
    }
  }

  const picked: Picked[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const p of candidates.sort()) {
    if (BINARY_EXT.test(p)) {
      skipped.push(`${p} (binary)`);
      continue;
    }
    let text: string;
    try {
      text = await host.readFile(p);
    } catch {
      skipped.push(`${p} (unreadable)`);
      continue;
    }
    if (text.includes("\u0000")) {
      skipped.push(`${p} (binary)`);
      continue;
    }
    if (text.length > MAX_FILE_CHARS) {
      skipped.push(`${p} (${text.length} chars, too large; use <read lines=>)`);
      continue;
    }
    // limit platí pro výslednou velikost (s hlavičkami a čísly řádků), ne pro holý obsah
    const rendered = renderFile(p, text);
    if (total + rendered.length > maxChars) {
      skipped.push(`${p} (bundle limit ${maxChars} chars reached)`);
      continue;
    }
    total += rendered.length;
    picked.push({ path: p, text: rendered, lines: text.split(/\r?\n/).length });
  }
  if (picked.length === 0) {
    return { tool: "bundle", attrs, status: "error", output: `No readable files matched.${skipped.length ? "\nSkipped: " + skipped.join(", ") : ""}` };
  }

  const out: string[] = [];
  out.push(`${BUNDLE_MARKER}: ${picked.length} files, project "${host.workspaceName}", turn ${turn}`);
  out.push("# Each file: '===== FILE: <path> (<n> lines) =====', numbered lines 'N| text', '===== END FILE ====='.");
  out.push("# Contents:");
  for (const f of picked) out.push(`#   ${f.path} (${f.lines} lines)`);
  out.push("");
  for (const f of picked) out.push(f.text, "");
  const content = out.join("\n");
  const rel = `.whisper/out/bundle-${turn}-${index}.txt`;
  await host.writeFile(rel, content);

  const summary = [
    `Bundle written to ${rel} (${picked.length} files, ${content.length} chars) and attached to this message as text/file.`,
    `Read the attached bundle instead of requesting these files with <read>. If you cannot see it, ask the user to paste the bundle from clipboard history (Win+V) or attach the file ${rel}.`,
    "Files:",
    ...picked.map((f) => `  ${f.path} (${f.lines} lines)`),
    ...(skipped.length ? ["Skipped:", ...skipped.map((s) => `  ${s}`)] : []),
  ].join("\n");
  return {
    tool: "bundle",
    attrs,
    status: "ok",
    output: summary,
    meta: { file: rel, files: picked.length, chars: content.length },
    attachments: [rel],
  };
}
