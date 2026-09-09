import { Host } from "../host/Host";
import { ActionResult } from "../protocol/schema";

const MAX_FILE_BYTES = 512 * 1024;
const MAX_MATCHES = 200;

export async function toolGrep(host: Host, attrs: Record<string, string>): Promise<ActionResult> {
  let re: RegExp;
  try {
    re = new RegExp(attrs.pattern, "i");
  } catch (e) {
    return { tool: "grep", attrs, status: "error", output: `Invalid regex: ${(e as Error).message}` };
  }
  const context = Math.min(5, Math.max(0, Number(attrs.context) || 0));
  const files = await host.listFiles(attrs.glob || "**/*", 5000);
  const out: string[] = [];
  let matches = 0;
  let scanned = 0;
  for (const f of files) {
    if (matches >= MAX_MATCHES) break;
    let text: string;
    try {
      text = await host.readFile(f);
    } catch {
      continue;
    }
    if (text.length > MAX_FILE_BYTES || text.includes("\u0000")) continue;
    scanned++;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && matches < MAX_MATCHES; i++) {
      if (!re.test(lines[i])) continue;
      matches++;
      if (context) {
        const from = Math.max(0, i - context);
        const to = Math.min(lines.length - 1, i + context);
        for (let k = from; k <= to; k++) out.push(`${f}:${k + 1}${k === i ? ":" : "-"} ${lines[k]}`);
        out.push("--");
      } else {
        out.push(`${f}:${i + 1}: ${lines[i]}`);
      }
    }
  }
  const capped = matches >= MAX_MATCHES ? `\n… (capped at ${MAX_MATCHES} matches; narrow the pattern or glob)` : "";
  return { tool: "grep", attrs, status: "ok", output: (out.join("\n") || "(no matches)") + capped, meta: { matches, files: scanned } };
}
