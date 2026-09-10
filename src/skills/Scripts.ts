import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Přípona podle shebangu nebo jazyka; když nic nesedí, bere se .sh (Unix) / .cmd (Windows). */
export function scriptExtension(body: string, lang?: string): string {
  const first = body.trimStart().split(/\r?\n/, 1)[0] ?? "";
  const hint = (lang ?? "").toLowerCase().trim();
  const table: Record<string, string> = {
    python: ".py",
    py: ".py",
    node: ".js",
    js: ".js",
    javascript: ".js",
    ts: ".ts",
    typescript: ".ts",
    bash: ".sh",
    sh: ".sh",
    shell: ".sh",
    powershell: ".ps1",
    ps1: ".ps1",
    pwsh: ".ps1",
    cmd: ".cmd",
    bat: ".cmd",
    batch: ".cmd",
    ruby: ".rb",
    perl: ".pl",
  };
  if (hint && table[hint]) return table[hint];
  if (first.startsWith("#!")) {
    if (/\bpython[\d.]*\b/.test(first)) return ".py";
    if (/\bnode\b/.test(first)) return ".js";
    if (/\b(bash|sh|zsh)\b/.test(first)) return ".sh";
    if (/\bpwsh|powershell\b/.test(first)) return ".ps1";
    if (/\bruby\b/.test(first)) return ".rb";
    if (/\bperl\b/.test(first)) return ".pl";
  }
  if (/^@echo off|^rem\s/im.test(body)) return ".cmd";
  if (/^param\s*\(|\$PSScriptRoot|Write-Host/m.test(body)) return ".ps1";
  if (/^\s*(def|import|from)\s+\w/m.test(body)) return ".py";
  if (/\b(require|module\.exports|console\.log)\b/.test(body)) return ".js";
  return process.platform === "win32" ? ".cmd" : ".sh";
}

/** Jak se skript spouští; jde do nápovědy pro uživatele i do WHISPER.md. */
export function runCommandFor(rel: string): string {
  switch (path.extname(rel).toLowerCase()) {
    case ".py":
      return `python ${rel}`;
    case ".js":
      return `node ${rel}`;
    case ".ts":
      return `npx tsx ${rel}`;
    case ".ps1":
      return `powershell -ExecutionPolicy Bypass -File ${rel}`;
    case ".sh":
      return `bash ${rel}`;
    case ".rb":
      return `ruby ${rel}`;
    case ".pl":
      return `perl ${rel}`;
    default:
      return rel;
  }
}

/**
 * Uloží skript navržený modelem do `.whisper/scripts/` (projekt) nebo `~/.whisper/scripts/` (globálně).
 * Vrací cestu relativní k workspace (u globálních absolutní) a příkaz ke spuštění.
 */
export function saveScript(
  workspaceRoot: string,
  name: string,
  body: string,
  opts: { global?: boolean; lang?: string; file?: string } = {},
): { rel: string; command: string; absolute: string } {
  const dirAbs = opts.global ? path.join(os.homedir(), ".whisper", "scripts") : path.join(workspaceRoot, ".whisper", "scripts");
  fs.mkdirSync(dirAbs, { recursive: true });
  // model může navrhnout konkrétní název souboru (file="tools/release.py"); jinak se odvodí z titulku
  const explicit = (opts.file ?? "").trim().replace(/\\/g, "/");
  const base = explicit
    ? path.basename(explicit)
    : (name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "script") + scriptExtension(body, opts.lang);
  const fileName = path.extname(base) ? base : base + scriptExtension(body, opts.lang);
  const absolute = path.join(dirAbs, fileName);
  let content = body.replace(/\r\n/g, "\n").trimEnd() + "\n";
  // shebang u unixových skriptů, aby šly spustit přímo
  if (/\.(sh|py|js|rb|pl)$/.test(fileName) && !content.startsWith("#!")) {
    const shebang: Record<string, string> = { ".sh": "#!/usr/bin/env bash", ".py": "#!/usr/bin/env python3", ".js": "#!/usr/bin/env node", ".rb": "#!/usr/bin/env ruby", ".pl": "#!/usr/bin/env perl" };
    content = shebang[path.extname(fileName)] + "\n" + content;
  }
  fs.writeFileSync(absolute, content, "utf8");
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(absolute, 0o755);
    } catch {
      /* na některých souborových systémech práva nejdou nastavit */
    }
  }
  const rel = opts.global ? absolute : path.relative(workspaceRoot, absolute).replace(/\\/g, "/");
  return { rel, command: runCommandFor(rel), absolute };
}
