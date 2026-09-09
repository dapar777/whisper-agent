/** Čisté textové utility bez závislosti na vscode. */

/** Jednoduché glob → RegExp (**, *, ?, {a,b}). Cesty s "/" oddělovači. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  while (i < g.length) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += g[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += g[i + 2] === "/" ? 3 : 2;
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end > 0) {
        re += "(?:" + g.slice(i + 1, end).split(",").map(escapeRe).join("|") + ")";
        i = end + 1;
        continue;
      }
      re += "\\{";
    } else re += escapeRe(c);
    i++;
  }
  return new RegExp("^" + re + "$");
}

function escapeRe(s: string): string {
  return s.replace(/[.+^$()|[\]\\]/g, "\\$&");
}

export function matchesAny(rel: string, globs: string[]): boolean {
  const r = rel.replace(/\\/g, "/");
  const base = r.split("/").pop() ?? r;
  return globs.some((g) => {
    const re = globToRegExp(g);
    return re.test(r) || re.test(base);
  });
}

export function nowId(): string {
  return Math.random().toString(36).slice(2, 6) + Date.now().toString(36).slice(-3);
}

export function sanitizeSecrets(text: string): string {
  return text
    .replace(/(api[_-]?key|secret|token|password|passwd|authorization)(["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi, "$1$2***")
    .replace(/\b(sk|ghp|gho|xoxb|xoxp|AKIA)[-_A-Za-z0-9]{16,}\b/g, "***");
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

export const DEFAULT_EXCLUDES = [
  "node_modules", ".git", "dist", "out", "build", ".whisper", "coverage", ".next", "target",
  "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache", "bin", "obj",
];

/** Načte jednoduché vzory z .gitignore (jen názvy bez * a bez negací). */
export function parseGitignoreNames(content: string): string[] {
  const names: string[] = [];
  for (const raw of content.split("\n")) {
    const l = raw.trim();
    if (!l || l.startsWith("#") || l.startsWith("!") || l.includes("*")) continue;
    names.push(l.replace(/^\/+/, "").replace(/\/+$/, ""));
  }
  return names;
}
