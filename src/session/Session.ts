import * as vscode from "vscode";
import { fileExists, readText, workspaceRoot, writeText } from "../util";
import { createSession, SessionData } from "./SessionData";

export type { SessionData, SessionState, TurnRecord } from "./SessionData";

const FILE = ".whisper/session.json";

/** Stav sezení ve VS Code: události pro UI + persistence do .whisper/session.json. */
export class Session implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<SessionData | undefined>();
  readonly onDidChange = this.emitter.event;
  private data: SessionData | undefined;

  get current(): SessionData | undefined {
    return this.data;
  }

  start(task: string, mode: "stateful" | "stateless"): SessionData {
    this.data = createSession(task, mode);
    this.notify();
    return this.data;
  }

  update(patch: Partial<SessionData>): SessionData {
    if (!this.data) throw new Error("Žádné aktivní sezení.");
    Object.assign(this.data, patch);
    this.notify();
    return this.data;
  }

  clear(): void {
    this.data = undefined;
    this.notify();
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private notify(): void {
    this.emitter.fire(this.data);
    void this.persist();
  }

  async persist(): Promise<void> {
    try {
      const uri = vscode.Uri.joinPath(workspaceRoot(), FILE);
      if (!this.data) {
        if (await fileExists(uri)) await vscode.workspace.fs.delete(uri);
        return;
      }
      await writeText(uri, JSON.stringify(this.data, null, 2));
    } catch {
      /* bez workspace nebo bez práv – ignoruj */
    }
  }

  async restore(): Promise<SessionData | undefined> {
    try {
      const uri = vscode.Uri.joinPath(workspaceRoot(), FILE);
      if (!(await fileExists(uri))) return undefined;
      const d = JSON.parse(await readText(uri)) as SessionData;
      if (d.state === "done" || d.state === "idle") return undefined;
      // po restartu nemůžeme být uprostřed vykonávání – vrať se do čekání na odpověď
      if (d.state === "executing") d.state = "waitingForReply";
      this.data = d;
      this.emitter.fire(d);
      return d;
    } catch {
      return undefined;
    }
  }
}
