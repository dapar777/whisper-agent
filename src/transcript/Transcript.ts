import { Host } from "../host/Host";

/** Jedna událost průběhu (úkol, prompt, odpověď, akce, schválení, otázka, návrh…). */
export interface TranscriptEvent {
  at: string;
  session: string;
  kind:
    | "task"
    | "prompt"
    | "reply"
    | "actions"
    | "results"
    | "status"
    | "approval"
    | "ask"
    | "answer"
    | "note"
    | "plan"
    | "suggestion"
    | "done"
    | "error"
    | "undo";
  turn?: number;
  text?: string;
  data?: unknown;
}

const FILE = ".whisper/transcript.jsonl";

/** Celý průběh práce agenta v .whisper/transcript.jsonl (append-only, přes všechna sezení). */
export class Transcript {
  constructor(private readonly host: Host) {}

  async append(ev: Omit<TranscriptEvent, "at">): Promise<void> {
    try {
      await this.host.appendFile(FILE, JSON.stringify({ at: new Date().toISOString(), ...ev }) + "\n");
    } catch {
      /* bez práv k zápisu – průběh se jen nezaloguje */
    }
  }

  async readAll(): Promise<TranscriptEvent[]> {
    if (!(await this.host.exists(FILE))) return [];
    const text = await this.host.readFile(FILE);
    const out: TranscriptEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as TranscriptEvent);
      } catch {
        /* poškozený řádek */
      }
    }
    return out;
  }

  /** Zhuštěný textový přehled průběhu pro prompt s návrhy (poslední `maxChars`). */
  static summarize(events: TranscriptEvent[], maxChars = 20000): string {
    const lines: string[] = [];
    let session = "";
    for (const e of events) {
      if (e.session !== session) {
        session = e.session;
        lines.push(`\n### Session ${session}`);
      }
      const t = (e.text ?? "").replace(/\s+/g, " ").trim();
      switch (e.kind) {
        case "task":
          lines.push(`TASK: ${t.slice(0, 400)}`);
          break;
        case "actions":
          lines.push(`turn ${e.turn}: actions ${t.slice(0, 300)}`);
          break;
        case "results":
          lines.push(`turn ${e.turn}: results ${t.slice(0, 300)}`);
          break;
        case "status":
          lines.push(`status: ${t.slice(0, 200)}`);
          break;
        case "approval":
          lines.push(`approval: ${t.slice(0, 200)}`);
          break;
        case "ask":
          lines.push(`model asked: ${t.slice(0, 300)}`);
          break;
        case "answer":
          lines.push(`user answered: ${t.slice(0, 300)}`);
          break;
        case "note":
          lines.push(`user note: ${t.slice(0, 300)}`);
          break;
        case "plan":
          lines.push(`plan updated (${t.split("- [").length - 1} items)`);
          break;
        case "suggestion":
          lines.push(`suggestion ${t.slice(0, 200)}`);
          break;
        case "done":
          lines.push(`DONE: ${t.slice(0, 400)}`);
          break;
        case "error":
          lines.push(`error: ${t.slice(0, 200)}`);
          break;
        case "undo":
          lines.push(`user undid turn ${e.turn}`);
          break;
        default:
          break;
      }
    }
    const text = lines.join("\n").trim();
    return text.length > maxChars ? "…\n" + text.slice(text.length - maxChars) : text;
  }
}
