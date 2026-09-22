import { ChildProcess, spawn } from "child_process";
import * as path from "path";
import * as readline from "readline";

export type DragResult = "copy" | "move" | "none" | "error";
export type DragMode = "keyboard" | "mouse";

export interface DragOutcome {
  result: DragResult;
  detail: string;
  /** trvání tažení v ms podle pomocníka */
  ms?: number;
}

/**
 * Trvale běžící pomocník pro přetažení souborů do jiného okna (jen Windows): scripts/dragdrop.py
 * --serve (Python s pywin32). Spouští se jednou a pak čeká na požadavky na stdin, takže tažení
 * začne do několika milisekund od požadavku: to je nutné u tažení myší, kde uživatel tlačítko drží
 * jen chvíli po stisknutí v panelu. Start Pythonu s pywin32 (přes sekundu) se zaplatí jednou.
 *
 * Nikdy nesmí nic zůstat viset: pomocník má na každé tažení pevný limit a všechno po sobě uklidí,
 * dispose() mu pošle cancel a zavře stdin (EOF = konec), po chvíli ho zabije.
 */
export class DragHelper {
  private child: ChildProcess | undefined;
  private ready: Promise<boolean> | undefined;
  private pending: { id: number; resolve: (o: DragOutcome) => void } | undefined;
  private seq = 0;
  private startedWith = "";
  /** proč se pomocník naposledy nespustil (do hlášky pro uživatele) */
  private lastError = "";

  constructor(
    private readonly scriptsDir: string,
    private readonly python: () => string,
    private readonly log: (line: string) => void,
  ) {}

  get busy(): boolean {
    return !!this.pending;
  }

  /** Spustí pomocníka na pozadí (když ještě neběží), aby první tažení nečekalo na start Pythonu. */
  warmUp(): void {
    void this.ensure();
  }

  private ensure(): Promise<boolean> {
    if (this.child && !this.child.killed && this.child.exitCode === null && this.ready) return this.ready;
    const script = path.join(this.scriptsDir, "dragdrop.py");
    const cmd = this.python() || "python";
    this.startedWith = cmd;
    this.ready = new Promise<boolean>((resolve) => {
      const t0 = Date.now();
      let settled = false;
      const done = (ok: boolean, why?: string) => {
        if (settled) return;
        settled = true;
        this.lastError = ok ? "" : why ?? "";
        if (!ok) this.log(`Pomocník pro tažení se nespustil${why ? ` (${why})` : ""}.`);
        else this.log(`Pomocník pro tažení připraven za ${Date.now() - t0} ms (${cmd}).`);
        resolve(ok);
      };
      const start = (exe: string, pre: string[]) => {
        let child: ChildProcess;
        try {
          // --parent: pomocník skončí sám, kdyby extension host zmizel bez zavření stdin
          child = spawn(exe, [...pre, script, "--serve", `--parent=${process.pid}`], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        } catch (e) {
          return done(false, (e as Error).message);
        }
        this.child = child;
        child.on("error", (e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT" && exe === "python") return start("py", ["-3"]); // spouštěč Pythonu
          done(false, e.message);
          this.failPending("error", e.message);
        });
        child.on("exit", (code) => {
          // po ENOENT může 'exit' přijít i za dítě, které už nahradil spouštěč py: to nesmí shodit start
          if (this.child !== child) return;
          this.child = undefined;
          done(false, `skončil s kódem ${code}`);
          // kód 3 = pomocník sám ukončil zaseknuté tažení (tlačítko uvolnil); pro uživatele je to zrušené tažení
          if (code === 3) this.failPending("none", "tažení se nedalo ukončit, pomocník se restartoval");
          else this.failPending("error", `pomocník skončil (kód ${code})`);
        });
        readline.createInterface({ input: child.stdout! }).on("line", (line) => this.onLine(line, done));
        readline.createInterface({ input: child.stderr! }).on("line", (line) => this.log(line));
      };
      start(cmd, []);
      setTimeout(() => done(false, "start trval přes 15 s"), 15_000);
    });
    return this.ready;
  }

  private onLine(line: string, ready: (ok: boolean, why?: string) => void): void {
    let msg: { result?: string; detail?: string; id?: number; ms?: number };
    try {
      msg = JSON.parse(line);
    } catch {
      return this.log(line);
    }
    if (msg.result === "ready") return ready(true);
    if (msg.result === "error" && msg.id === undefined && !this.pending) return ready(false, msg.detail);
    if (this.pending && (msg.id === undefined || msg.id === this.pending.id)) {
      const p = this.pending;
      this.pending = undefined;
      p.resolve({ result: (msg.result as DragResult) ?? "error", detail: msg.detail ?? "", ms: msg.ms });
    }
  }

  private failPending(result: DragResult, detail: string): void {
    const p = this.pending;
    this.pending = undefined;
    p?.resolve({ result, detail });
  }

  /** Jedno tažení; když už jedno běží, vrátí error "busy". */
  async drag(files: string[], mode: DragMode, autoCancel = 0): Promise<DragOutcome> {
    if (this.pending) return { result: "error", detail: "busy" };
    if (!(await this.ensure()) || !this.child?.stdin) {
      return { result: "error", detail: /ENOENT/.test(this.lastError) ? "ENOENT" : this.lastError || "pomocník neběží" };
    }
    const id = ++this.seq;
    return new Promise<DragOutcome>((resolve) => {
      this.pending = { id, resolve };
      this.child!.stdin!.write(JSON.stringify({ cmd: "drag", id, files, mode, autoCancel }) + "\n");
    });
  }

  /** Zruší tažení, které právě běží (odpověď dostane původní požadavek). */
  cancel(): void {
    if (this.child?.stdin && this.pending) this.child.stdin.write(JSON.stringify({ cmd: "cancel" }) + "\n");
  }

  dispose(): void {
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    if (!child) return;
    try {
      if (this.pending) child.stdin?.write(JSON.stringify({ cmd: "cancel" }) + "\n");
      child.stdin?.end(); // EOF: pomocník uklidí a skončí
    } catch {
      /* už je pryč */
    }
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 1500);
  }
}
