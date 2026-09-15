import { execFile } from "child_process";
import * as path from "path";

export type DragResult = "copy" | "move" | "none" | "error";

/**
 * Přetažení souborů do jiného okna z klávesnice (jen Windows): spustí scripts/dragdrop.py (Python
 * s pywin32), který začne OLE drag; uživatel Alt+Tabem přepne do chatu a Enterem soubor pustí
 * (Esc zruší). Čeká na konec tažení. Když `python` není v PATH, zkusí spouštěč `py -3`.
 */
export function dragFiles(scriptsDir: string, files: string[], python = "python"): Promise<{ result: DragResult; detail: string }> {
  const script = path.join(scriptsDir, "dragdrop.py");
  const run = (cmd: string, pre: string[]) =>
    new Promise<{ result: DragResult; detail: string }>((resolve) => {
      execFile(cmd, [...pre, script, ...files], { windowsHide: true, timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
        const out = String(stdout ?? "").trim();
        const errText = String(stderr ?? "").trim();
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return resolve({ result: "error", detail: "ENOENT" });
        if (out === "copy" || out === "move") return resolve({ result: out, detail: "" });
        if (out === "none") return resolve({ result: "none", detail: "" });
        resolve({ result: "error", detail: errText || out || (err ? err.message : "unknown") });
      });
    });
  return run(python, []).then((r) => (r.result === "error" && r.detail === "ENOENT" && python === "python" ? run("py", ["-3"]) : r));
}
