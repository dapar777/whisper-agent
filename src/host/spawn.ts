import { ChildProcess, spawn } from "child_process";
import { sanitizeSecrets, stripAnsi } from "../protocol/text";
import { RunResult } from "./Host";

const MAX_OUTPUT = 2_000_000;
const TICK_MS = 500;
/** Delší mezera mezi tiky = proces (i my) stál, typicky uspaný počítač. */
const SUSPEND_GAP_MS = 5_000;

/**
 * Ukončí celý strom procesů. Na Windows `child.kill()` zabije jen shell a osiřelý
 * potomek (npm, node, python) by běžel dál a držel roury; proto nejdřív `taskkill /T`
 * a teprve po jeho doběhu záložní `kill()`.
 */
function terminate(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      const tk = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      const fallback = () => {
        if (child.exitCode === null && !child.killed) child.kill();
      };
      tk.on("exit", fallback);
      tk.on("error", fallback);
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* skupina už neexistuje */
      }
      child.kill("SIGKILL");
    }
  } catch {
    /* proces už neběží */
  }
}

/** Spustí shellový příkaz a posbírá stdout+stderr (sdílené oběma hosty). */
export function spawnCommand(command: string, cwd: string, timeoutMs: number, probeMs?: number, signal?: AbortSignal): Promise<RunResult> {
  const started = Date.now();
  return new Promise<RunResult>((resolve) => {
    const chunks: string[] = [];
    let size = 0;
    let timedOut = false;
    let stillRunning = false;
    let interrupted = false;
    if (signal?.aborted) {
      resolve({ output: "", exit: -1, timedOut: false, interrupted: true, durationMs: 0 });
      return;
    }
    // extension host VS Code nastavuje ELECTRON_RUN_AS_NODE=1; zděděné by rozbilo spouštění Electron aplikací
    const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", FORCE_COLOR: "0", PYTHONIOENCODING: "utf-8" };
    delete env.ELECTRON_RUN_AS_NODE;
    // některá prostředí zakazují cmd.exe hledat spustitelné soubory v cwd; agent běží záměrně ve workspace
    delete env.NoDefaultCurrentDirectoryInExePath;
    const child = spawn(command, {
      cwd,
      shell: true,
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const onData = (d: Buffer) => {
      if (size > MAX_OUTPUT) return;
      const s = d.toString("utf8");
      size += s.length;
      chunks.push(s);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    // Lhůty měříme „aktivním“ časem: když notebook usne (modern standby), časovače
    // stojí a po probuzení by jinak timeout vypršel okamžitě, i když příkaz reálně
    // běžel jen pár sekund. Mezera mezi tiky delší než SUSPEND_GAP_MS se nepočítá.
    let active = 0;
    let suspendedMs = 0;
    let lastTick = Date.now();
    const ticker = setInterval(() => {
      const now = Date.now();
      const gap = now - lastTick;
      lastTick = now;
      if (gap > SUSPEND_GAP_MS) {
        suspendedMs += gap - TICK_MS;
        active += TICK_MS;
      } else {
        active += gap;
      }
      // probe: po probeMs proces ukončíme a ohlásíme, že stále běžel (= úspěšný start GUI/serveru)
      if (probeMs && !stillRunning && !timedOut && active >= probeMs) {
        stillRunning = true;
        terminate(child);
      } else if (!timedOut && !stillRunning && active >= timeoutMs) {
        timedOut = true;
        terminate(child);
      }
    }, TICK_MS);
    const onAbort = () => {
      interrupted = true;
      terminate(child);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (exit: number, extra = "") => {
      clearInterval(ticker);
      signal?.removeEventListener("abort", onAbort);
      const output = sanitizeSecrets(stripAnsi(extra + chunks.join(""))).trim();
      resolve({ output, exit, timedOut, stillRunning, interrupted, durationMs: Date.now() - started - suspendedMs, suspendedMs });
    };
    child.on("error", (err) => finish(-1, `Failed to start: ${err.message}\n`));
    child.on("close", (code) => finish(code ?? -1));
  });
}
