import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const SCRIPT = path.join(process.cwd(), "scripts", "dragdrop.py");
const isWin = process.platform === "win32";
const hasPywin32 = isWin && spawnSync("python", ["-c", "import pythoncom, win32com.shell"], { windowsHide: true }).status === 0;

function run(args: string[], timeout = 30000): { code: number; out: string; err: string } {
  const r = spawnSync("python", [SCRIPT, ...args], { windowsHide: true, timeout, encoding: "utf8", killSignal: "SIGKILL" });
  if (r.error) throw new Error(`${r.error.message} (stdout: ${r.stdout ?? ""}, stderr: ${r.stderr ?? ""})`);
  return { code: r.status ?? -1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

describe("dragdrop.py", () => {
  it("is valid Python", () => {
    expect(() => execFileSync("python", ["-m", "py_compile", SCRIPT], { windowsHide: true })).not.toThrow();
  });

  it.skipIf(!hasPywin32)("--check verifies pywin32 and the status window without dragging", () => {
    const r = run(["--check"]);
    expect(r.out).toBe("ok");
    expect(r.code).toBe(0);
  });

  it.skipIf(!hasPywin32)("--mouse waits only briefly for the held button instead of hanging", () => {
    const file = path.join(os.tmpdir(), `whisper-drag-${process.pid}.txt`);
    fs.writeFileSync(file, "x", "utf8");
    try {
      // Bez drženého tlačítka se drag nesmí spustit ani zablokovat. Jestli tlačítko zrovna
      // držené JE (uživatel u počítače, jiný test klikl), drag se rozběhne a skončí, až ho
      // pustí; proto se tu ověřuje jen to, že se proces nezasekne a skončí známým výsledkem.
      const r = run(["--mouse", file], 25000);
      expect(["none", "copy", "move"]).toContain(r.out);
      expect([0, 1]).toContain(r.code);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("reports a missing file instead of starting a drag", () => {
    const r = run(["--mouse", path.join(os.tmpdir(), "whisper-does-not-exist.txt")], 20000);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/file not found/i);
  });
});
