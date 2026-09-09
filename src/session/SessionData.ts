import { TurnSummary } from "../protocol/PromptBuilder";
import { Action, ActionResult } from "../protocol/schema";
import { nowId } from "../protocol/text";

export type SessionState =
  | "idle"
  | "composing"
  | "waitingForReply"
  | "executing"
  | "awaitingUser" // model položil otázku (<ask>)
  | "awaitingReview" // čeká na review změn
  | "done";

export interface TurnRecord {
  turn: number;
  at: string;
  promptChars: number;
  actions: Action[];
  results: ActionResult[];
  prose?: string;
  status?: string;
  errors?: string[];
  /** přímé výměny v chatu zapsané modelem přes <dialog> */
  dialog?: { from: "model" | "user"; text: string }[];
}

export interface SessionData {
  id: string;
  task: string;
  mode: "stateful" | "stateless";
  state: SessionState;
  /** číslo kola, na které právě čekáme / které se vykonává */
  turn: number;
  history: TurnRecord[];
  summaries: TurnSummary[];
  pendingPrompt: string;
  /** soubory (obrázky) patřící k čekajícímu promptu; relativní cesty */
  pendingAttachments?: string[];
  pendingQuestion?: string;
  /** možnosti odpovědi na čekající otázku; multi = lze vybrat více */
  pendingOptions?: string[];
  pendingMulti?: boolean;
  createdAt: string;
  finalSummary?: string;
  /** režim PLAN vynucený uživatelem (/plan) */
  planMode?: boolean;
  /** aktuální plán (markdown checklist) */
  plan?: string;
  /** návrhy od modelu čekající na schválení */
  suggestions?: Suggestion[];
  /** poznámky uživatele napsané během čekání; přiloží se k dalšímu promptu */
  notes?: string[];
}

export type SuggestionKind = "skill" | "whisper" | "rule" | "hook" | "allow" | "setting" | "task" | "agent";

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  /** project = jen tento workspace; global = chování agenta všude (~/.whisper, uživatelská nastavení) */
  scope: "project" | "global";
  title: string;
  body: string;
  turn: number;
  /** úprava existující položky místo nové: název skillu, "rule N" nebo match hooku */
  update?: string;
  /** automaticky odhalený duplikát něčeho, co už existuje */
  duplicate?: boolean;
  decision?: "approved" | "rejected";
}

export function createSession(task: string, mode: "stateful" | "stateless"): SessionData {
  return {
    id: nowId(),
    task,
    mode,
    state: "composing",
    turn: 1,
    history: [],
    summaries: [],
    pendingPrompt: "",
    createdAt: new Date().toISOString(),
  };
}
