import { execFile } from "child_process";
import * as path from "path";

export type DragResult = "copy" | "move" | "none" | "error";

/**
 * Přetažení souborů do jiného okna (jen Windows): spustí scripts/dragdrop.py (Python s pywin32),
 * který začne OLE drag. Bez `mouse` jde o tažení z klávesnice (Alt+Tab do cíle, Enter pustí, Esc
 * zruší); s `mouse` uživatel drží tlačítko sám a pustí ho, kam chce. Čeká na konec tažení.
 * Když `python` není v PATH, zkusí spouštěč `py -3`.
 */
export function dragFiles(scriptsDir: string, files: string[], python = "python", mouse = false): Promise<{ result: DragResult; detail: string }> {
  const script = path.join(scriptsDir, "dragdrop.py");
  const args = mouse ? ["--mouse", ...files] : files;
  const run = (cmd: string, pre: string[]) =>
    new Promise<{ result: DragResult; detail: string }>((resolve) => {
      execFile(cmd, [...pre, script, ...args], { windowsHide: true, timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
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
