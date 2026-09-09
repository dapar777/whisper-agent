import * as path from "path";
import { Host } from "../host/Host";
import { ActionResult } from "../protocol/schema";

/** Předrenderovaný strom pro preambuli. */
export async function renderTree(host: Host, maxEntries: number): Promise<string> {
  const files = await host.listFiles("**/*", 5000);
  if (files.length <= maxEntries) return files.join("\n") || "(empty workspace)";
  const dirs = new Map<string, number>();
  for (const f of files) {
    const d = path.posix.dirname(f);
    dirs.set(d, (dirs.get(d) ?? 0) + 1);
  }
  const lines: string[] = files.filter((f) => !f.includes("/"));
  const sortedDirs = [...dirs.entries()].filter(([d]) => d !== ".").sort();
  for (const [d, n] of sortedDirs) {
    if (lines.length >= maxEntries) {
      lines.push(`… (${sortedDirs.length - (lines.length - files.filter((f) => !f.includes("/")).length)} more directories; use <ls>/<glob> to explore)`);
      break;
    }
    lines.push(`${d}/ (${n} files)`);
  }
  return lines.join("\n");
}

export async function toolRead(host: Host, attrs: Record<string, string>): Promise<ActionResult> {
  if (!(await host.exists(attrs.path))) return { tool: "read", attrs, status: "error", output: `File not found: ${attrs.path}` };
  const text = await host.readFile(attrs.path);
  const lines = text.split(/\r?\n/);
  let from = 1;
  let to = lines.length;
  if (attrs.lines) {
    const m = attrs.lines.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!m) return { tool: "read", attrs, status: "error", output: `Invalid lines="${attrs.lines}", expected "A-B".` };
    from = Math.max(1, Number(m[1]));
    to = Math.min(lines.length, Number(m[2]));
  } else if (lines.length > 400) {
    return {
      tool: "read",
      attrs,
      status: "error",
      output: `File has ${lines.length} lines; request a range with lines="A-B" (e.g. 1-200).`,
      meta: { totalLines: lines.length },
    };
  }
  const width = String(to).length;
  const out = lines
    .slice(from - 1, to)
    .map((l, i) => `${String(from + i).padStart(width)}| ${l}`)
    .join("\n");
  return { tool: "read", attrs, status: "ok", output: out, meta: { totalLines: lines.length } };
}

export async function toolLs(host: Host, attrs: Record<string, string>): Promise<ActionResult> {
  const rel = attrs.path && attrs.path !== "." ? attrs.path.replace(/\\/g, "/").replace(/\/+$/, "") : "";
  const depth = Math.min(4, Math.max(1, Number(attrs.depth) || 1));
  if (rel && !(await host.exists(rel))) return { tool: "ls", attrs, status: "error", output: `Directory not found: ${attrs.path}` };
  const files = await host.listFiles(rel ? `${rel}/**/*` : "**/*", 5000);
  const prefixLen = rel ? rel.length + 1 : 0;
  const entries = new Set<string>();
  for (const f of files) {
    const parts = f.slice(prefixLen).split("/");
    for (let d = 1; d <= Math.min(depth, parts.length); d++) {
      const p = parts.slice(0, d).join("/");
      entries.add(d < parts.length ? p + "/" : p);
    }
  }
  const list = [...entries].sort();
  const shown = list.slice(0, 500);
  const more = list.length > shown.length ? `\n… (${list.length - shown.length} more entries)` : "";
  return { tool: "ls", attrs, status: "ok", output: (shown.join("\n") || "(empty)") + more, meta: { entries: list.length } };
}

export async function toolGlob(host: Host, attrs: Record<string, string>): Promise<ActionResult> {
  const files = await host.listFiles(attrs.pattern, 500);
  return { tool: "glob", attrs, status: "ok", output: files.join("\n") || "(no matches)", meta: { matches: files.length } };
}
