// Tyto testy skutečně táhnou: instalují low-level hook klávesnice, drží tlačítko myši a hýbou
// kurzorem. Souběžně s ostatními testy (spouštění procesů, hooky) to kolidovalo, proto je `npm test`
// spouští až po ostatních, samostatně.
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DragHelper } from "../src/clipboard/DragDrop";

const SCRIPTS = path.join(process.cwd(), "scripts");
const SCRIPT = path.join(SCRIPTS, "dragdrop.py");
const isWin = process.platform === "win32";
const hasPywin32 = isWin && spawnSync("python", ["-c", "import pythoncom, win32com.shell"], { windowsHide: true }).status === 0;
const buttonDown = () =>
  isWin &&
  spawnSync("python", ["-c", "import ctypes;print(int(bool(ctypes.windll.user32.GetAsyncKeyState(0x01) & 0x8000)))"], { windowsHide: true, encoding: "utf8" }).stdout?.trim() === "1";
// zamčený počítač: v popředí je LockApp, žádné tažení nemůže začít; interaktivní testy se přeskočí
const sessionLocked = () =>
  isWin &&
  spawnSync("python", ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(SCRIPTS)}); import dragdrop; print(dragdrop.session_locked() or "")`], { windowsHide: true, encoding: "utf8" }).stdout?.trim() !== "";
const canDrag = hasPywin32 && !sessionLocked();

const helpers: DragHelper[] = [];
function helper(log: string[] = []): DragHelper {
  const h = new DragHelper(SCRIPTS, () => "python", (l) => log.push(l));
  helpers.push(h);
  return h;
}
afterAll(() => helpers.forEach((h) => h.dispose()));

describe("dragdrop.py", () => {
  it("is valid Python", () => {
    expect(() => execFileSync("python", ["-m", "py_compile", SCRIPT], { windowsHide: true })).not.toThrow();
  });

  it.skipIf(!hasPywin32)("--check verifies pywin32 and the status window without dragging", () => {
    const r = spawnSync("python", [SCRIPT, "--check"], { windowsHide: true, encoding: "utf8", timeout: 30000 });
    expect(r.stdout.trim()).toBe("ok");
    expect(r.status).toBe(0);
  });

  it.skipIf(!canDrag)("--selftest-mouse: a mouse-driven drag ends when the button is released", () => {
    // vlastní okno bez drop targetu: tažení proběhne, ale nikam se nic nepustí
    const r = spawnSync("python", [SCRIPT, "--selftest-mouse"], { windowsHide: true, encoding: "utf8", timeout: 30000 });
    expect(r.stdout.trim(), r.stderr).toBe("ok");
    expect(r.status).toBe(0);
    expect(buttonDown()).toBe(false);
  });
});

describe("DragHelper (persistent dragdrop.py --serve)", () => {
  it.skipIf(!hasPywin32)("starts once, answers fast, and refuses a mouse drag when no button is held", async () => {
    const log: string[] = [];
    const h = helper(log);
    const file = path.join(os.tmpdir(), `whisper-drag-${process.pid}.txt`);
    fs.writeFileSync(file, "x", "utf8");
    try {
      const t0 = Date.now();
      const first = await h.drag([file], "mouse");
      const firstMs = Date.now() - t0;
      // bez drženého tlačítka: "none" (nebo drop/cancel, kdyby zrovna někdo tlačítko držel); na zamčeném
      // počítači rovnou "error" se zdůvodněním. V žádném případě nic nesmí viset.
      const acceptable = canDrag ? ["none", "copy", "move"] : ["error"];
      expect(acceptable).toContain(first.result);
      if (!canDrag) expect(first.detail).toMatch(/locked|foreground/);
      expect(log.some((l) => /Pomocník pro tažení připraven/.test(l))).toBe(true);
      // druhý požadavek už neplatí start Pythonu: čekání na tlačítko je 0,4 s, celé musí být rychlé
      const t1 = Date.now();
      const second = await h.drag([file], "mouse");
      expect(acceptable).toContain(second.result);
      expect(Date.now() - t1).toBeLessThan(2500);
      expect(firstMs).toBeLessThan(20000);
      expect(h.busy).toBe(false);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it.skipIf(!canDrag)("a keyboard drag that cancels itself releases the synthetic button and reports none", async () => {
    const h = helper();
    const file = path.join(os.tmpdir(), `whisper-drag-k-${process.pid}.txt`);
    fs.writeFileSync(file, "x", "utf8");
    try {
      const r = await h.drag([file], "keyboard", 1.5);
      expect(r.result).toBe("none");
      expect(r.ms).toBeGreaterThan(1200); // tažení opravdu běželo až do zrušení
      // nic nezůstalo viset: tlačítko není logicky stisknuté
      await new Promise((res) => setTimeout(res, 200));
      expect(buttonDown()).toBe(false);
      expect(h.busy).toBe(false);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it.skipIf(!canDrag)("cancel() ends a running drag, and a missing file is an error, not a hang", async () => {
    const h = helper();
    const file = path.join(os.tmpdir(), `whisper-drag-c-${process.pid}.txt`);
    fs.writeFileSync(file, "x", "utf8");
    try {
      const pending = h.drag([file], "keyboard");
      await new Promise((res) => setTimeout(res, 900));
      expect(h.busy).toBe(true);
      h.cancel();
      const r = await pending;
      expect(r.result).toBe("none");
      const missing = await h.drag([path.join(os.tmpdir(), "whisper-does-not-exist.txt")], "keyboard");
      expect(missing.result).toBe("error");
      expect(missing.detail).toMatch(/file not found/);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("reports ENOENT-like failures instead of hanging when the interpreter is missing", async () => {
    const h = new DragHelper(SCRIPTS, () => "definitely-not-a-python-binary", () => undefined);
    helpers.push(h);
    const r = await h.drag([SCRIPT], "keyboard");
    expect(r.result).toBe("error");
  });
});
