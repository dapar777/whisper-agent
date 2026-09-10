import * as fs from "fs";
import * as path from "path";
import { looksLikeReply } from "../protocol/replyDetect";
import { globToRegExp } from "../protocol/text";

export interface FileReplyOptions {
  /** sledovaná složka (absolutní cesta) */
  dir: string;
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
}

interface Seen {
  size: number;
  mtime: number;
  /** už přečteno a vyhodnoceno (odpověď nebo ne) */
  done?: boolean;
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

  constructor(private readonly opts: FileReplyOptions) {
    this.re = globToRegExp(opts.pattern || "*.{md,txt}");
  }

  /** Zapamatuje si stávající soubory a začne hlídat nové. */
  start(): void {
    this.stop();
    for (const f of this.scan()) this.seen.set(f.name, { size: f.size, mtime: f.mtime, done: true });
    this.timer = setInterval(() => void this.tick(), Math.max(200, this.opts.pollMs));
    this.opts.log?.(`Hlídám složku ${this.opts.dir} (${this.opts.pattern}) pro odpověď v souboru.`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private scan(): { name: string; size: number; mtime: number }[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.opts.dir);
    } catch {
      return [];
    }
    const out: { name: string; size: number; mtime: number }[] = [];
    for (const name of names) {
      if (!this.re.test(name)) continue;
      try {
        const st = fs.statSync(path.join(this.opts.dir, name));
        if (st.isFile()) out.push({ name, size: st.size, mtime: st.mtimeMs });
      } catch {
        /* soubor mezitím zmizel */
      }
    }
    return out;
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const f of this.scan()) {
        const prev = this.seen.get(f.name);
        if (prev?.done) continue;
        if (!prev || prev.size !== f.size || prev.mtime !== f.mtime) {
          // nový nebo ještě rozepsaný soubor: počkat na další tik se stejnou velikostí
          this.seen.set(f.name, { size: f.size, mtime: f.mtime });
          continue;
        }
        if (f.size === 0) continue;
        prev.done = true;
        let text: string;
        try {
          text = fs.readFileSync(path.join(this.opts.dir, f.name), "utf8").replace(/^\uFEFF/, "");
        } catch {
          continue;
        }
        if (looksLikeReply(text, this.opts.lastPrompt)) {
          this.opts.log?.(`Odpověď převzata ze souboru ${f.name} (${text.length} znaků).`);
          this.stop();
          this.opts.onReply(text, path.join(this.opts.dir, f.name));
          return;
        }
        this.opts.log?.(`Soubor ${f.name} nevypadá jako odpověď (chybí blok <whisper turn=…>), ignoruji.`);
      }
    } finally {
      this.busy = false;
    }
  }
}
