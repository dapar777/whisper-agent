import * as fs from "fs";
import * as path from "path";
import { looksLikeReply } from "../protocol/replyDetect";
import { globToRegExp } from "../protocol/text";

export interface FileReplyOptions {
  /** sledovaná složka (absolutní cesta) */
  dir: string;
  /** další sledované složky (skutečná složka stahování, ~/Downloads, nastavené); `dir` je v nich vždy */
  dirs?: string[];
  /** glob na název souboru, např. "*.md" nebo "*.{md,txt}" */
  pattern: string;
  /** interval kontroly v ms */
  pollMs: number;
  /** aktuální prompt (aby se náš vlastní text nebral jako odpověď) */
  lastPrompt: string;
  /** volá se s obsahem prvního nového souboru, který vypadá jako odpověď */
  onReply: (text: string, file: string) => void;
  /** volitelný log */
  log?: (line: string) => void;
  /** čtení souboru (testy podstrčí zamčený soubor); výchozí fs.readFileSync */
  readFile?: (p: string) => string;
}

interface Seen {
  size: number;
  mtime: number;
  /** už přečteno a vyhodnoceno (odpověď nebo ne); přepsání souboru to vrátí */
  done?: boolean;
  /** neúspěšné pokusy o přečtení (zamčený soubor) */
  tries?: number;
}

/**
 * Alternativa ke schránce: odpověď modelu přijde jako NOVÝ soubor ve sledované složce
 * (např. stažený z chatu). Soubory existující při startu čekání se ignorují; nový soubor se
 * přečte, až se přestane měnit (stahování dopisuje po částech), a ověří stejně jako text
 * ze schránky (`looksLikeReply`).
 */
export class FileReplyWatcher {
  private timer: NodeJS.Timeout | undefined;
  private readonly seen = new Map<string, Seen>();
  private readonly re: RegExp;
  private busy = false;

  private readonly dirs: string[];

  constructor(private readonly opts: FileReplyOptions) {
    this.re = globToRegExp(opts.pattern || "*.{xml,md,txt}");
    const all = [opts.dir, ...(opts.dirs ?? [])];
    this.dirs = all.filter((d, i) => d && all.findIndex((x) => x.toLowerCase() === d.toLowerCase()) === i);
  }

  /** Zapamatuje si stávající soubory a začne hlídat nové. */
  start(): void {
    this.stop();
    const existing = this.scan();
    for (const f of existing) this.seen.set(f.key, { size: f.size, mtime: f.mtime, done: true });
    this.timer = setInterval(() => void this.tick(), Math.max(200, this.opts.pollMs));
    this.opts.log?.(`Hlídám ${this.dirs.join("; ")} (${this.opts.pattern}) pro odpověď v souboru; ${existing.length} dřívějších souborů ignoruji, změněné znovu posoudím.`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Soubory odpovídající vzoru ve všech sledovaných složkách; key = celá cesta (složky se mohou shodovat ve jménech). */
  private scan(): { key: string; path: string; name: string; size: number; mtime: number }[] {
    const out: { key: string; path: string; name: string; size: number; mtime: number }[] = [];
    for (const dir of this.dirs) {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue; // složka neexistuje (přesměrovaná, odpojený disk): ostatní se hlídají dál
      }
      for (const name of names) {
        if (!this.re.test(name)) continue;
        const full = path.join(dir, name);
        try {
          const st = fs.statSync(full);
          if (st.isFile()) out.push({ key: full.toLowerCase(), path: full, name, size: st.size, mtime: st.mtimeMs });
        } catch {
          /* soubor mezitím zmizel */
        }
      }
    }
    return out;
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const f of this.scan()) {
        const prev = this.seen.get(f.key);
        const changed = !prev || prev.size !== f.size || prev.mtime !== f.mtime;
        // hotový soubor, který se od té doby nezměnil: nic nového
        if (prev?.done && !changed) continue;
        if (changed) {
          // nový, rozepsaný, nebo PŘEPSANÝ soubor (stejné jméno, nový obsah): počkat na další tik se
          // stejnou velikostí a pak ho vyhodnotit znovu, i kdyby byl dřív odmítnutý
          this.opts.log?.(prev?.done ? `Soubor ${f.name} se změnil, vyhodnotím ho znovu.` : `Nový soubor ${f.name} (${f.size} B), čekám, až se dopíše.`);
          this.seen.set(f.key, { size: f.size, mtime: f.mtime, tries: 0 });
          continue;
        }
        if (f.size === 0) continue;
        let text: string;
        try {
          text = (this.opts.readFile ?? ((p: string) => fs.readFileSync(p, "utf8")))(f.path).replace(/^\uFEFF/, "");
        } catch (e) {
          // čerstvě stažený soubor bývá chvíli zamčený (prohlížeč, antivir): zkusit znovu, ne odepsat
          prev.tries = (prev.tries ?? 0) + 1;
          if (prev.tries >= 10) {
            prev.done = true;
            this.opts.log?.(`Soubor ${f.name} nejde přečíst (${(e as Error).message}), vzdávám to.`);
          }
          continue;
        }
        prev.done = true;
        if (looksLikeReply(text, this.opts.lastPrompt)) {
          this.opts.log?.(`Odpověď převzata ze souboru ${f.name} (${text.length} znaků).`);
          this.stop();
          this.opts.onReply(text, f.path);
          return;
        }
        this.opts.log?.(`Soubor ${f.name} nevypadá jako odpověď (chybí blok <whisper turn=…>), ignoruji.`);
      }
    } finally {
      this.busy = false;
    }
  }
}
