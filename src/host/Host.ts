import { FileEncoding } from "../tools/encoding";

/**
 * Rozhraní k prostředí, ve kterém agent běží. Implementace: VsCodeHost
 * (extension) a NodeHost (headless CLI / testy). Nástroje pracují jen s ním.
 */

export interface RunResult {
  output: string;
  exit: number;
  timedOut: boolean;
  /** probe režim: proces po uplynutí probeMs stále běžel (a byl ukončen) */
  stillRunning?: boolean;
  /** uživatel běh přerušil */
  interrupted?: boolean;
  /** aktivní doba běhu (bez doby, kdy byl počítač uspaný) */
  durationMs: number;
  /** kolik ms byl během příkazu počítač uspaný (0 = nebyl) */
  suspendedMs?: number;
}

export interface HostPolicy {
  /** prefixy příkazů spouštěných bez potvrzení */
  autoAllow: string[];
  /** regulární výrazy na celý příkaz, které se spouštějí bez potvrzení */
  allowPatterns?: string[];
  /** podřetězce příkazů, které se nikdy nespustí */
  deny: string[];
  /** globy chráněných cest */
  protectedPaths: string[];
}

export interface Host {
  readonly workspaceName: string;
  readonly policy: HostPolicy;

  /** Ověří, že relativní cesta leží ve workspace; jinak vyhodí chybu. */
  assertInside(rel: string): void;
  exists(rel: string): Promise<boolean>;
  /** Obsah souboru; kódování se pozná z bajtů, konce řádků se sjednotí na LF. */
  readFile(rel: string): Promise<string>;
  /** Zápis; u existujícího souboru se zachová jeho kódování, BOM i konce řádků. */
  writeFile(rel: string, text: string): Promise<void>;
  /** Jak je soubor uložený (kódování, BOM, konce řádků); u neexistujícího výchozí nastavení. */
  fileEncoding(rel: string): Promise<FileEncoding>;
  /** Připojí text na konec souboru (založí ho, pokud chybí). */
  appendFile(rel: string, text: string): Promise<void>;
  deleteFile(rel: string): Promise<void>;
  /** Relativní cesty souborů (posix oddělovače), seřazené, bez ignorovaných adresářů. */
  listFiles(glob: string, max?: number): Promise<string[]>;
  /** probeMs: po uplynutí proces ukončit a vrátit stillRunning=true (ověření startu GUI/serveru) */
  run(command: string, cwdRel: string, timeoutMs: number, probeMs?: number, signal?: AbortSignal): Promise<RunResult>;
  /** Textový výpis chyb/varování; prázdný řetězec, když nic není nebo není k dispozici. */
  diagnostics(onlyRel?: string): Promise<string>;
  /** Snímek obrazovky/okna do PNG na relativní cestě; vrací rozměry a titulek okna. */
  screenshot(rel: string, opts: { window?: string }): Promise<{ width: number; height: number; window?: string }>;
  /** Absolutní cesta k souboru ve workspace (pro přílohy do schránky). */
  absolutePath(rel: string): string;
  confirmCommand(command: string, cwdRel: string): Promise<boolean>;
  confirmDelete(rel: string): Promise<boolean>;
  log(line: string): void;
}
