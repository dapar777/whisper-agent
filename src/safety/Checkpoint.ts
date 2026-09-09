import { execFile } from "child_process";
import * as vscode from "vscode";
import { cfg, fileExists, resolveInWorkspace, workspaceRoot } from "../util";

export interface CheckpointInfo {
  turn: number;
  /** commit hash snapshotu (git stash create) nebo "HEAD" */
  ref: string;
  /** soubory vytvořené v tomto kole (nejsou v snapshotu) */
  created: string[];
}

function git(args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: workspaceRoot().fsPath, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || stderr || "").toString().trim() });
    });
  });
}

/** Git checkpoint pro Undo kola. Bez gitu vrací undefined. */
export class Checkpoint {
  private stack: CheckpointInfo[] = [];

  async isRepo(): Promise<boolean> {
    if (!cfg<boolean>("checkpoint.git", true)) return false;
    const r = await git(["rev-parse", "--is-inside-work-tree"]);
    return r.ok && r.out === "true";
  }

  async take(turn: number): Promise<CheckpointInfo | undefined> {
    if (!(await this.isRepo())) return undefined;
    const r = await git(["stash", "create"]);
    const info: CheckpointInfo = { turn, ref: r.ok && r.out ? r.out : "HEAD", created: [] };
    this.stack.push(info);
    if (this.stack.length > 20) this.stack.shift();
    return info;
  }

  noteCreated(turn: number, rel: string): void {
    const cp = this.stack.find((c) => c.turn === turn);
    if (cp && !cp.created.includes(rel)) cp.created.push(rel);
  }

  get last(): CheckpointInfo | undefined {
    return this.stack[this.stack.length - 1];
  }

  /** Vrátí sledované soubory do stavu checkpointu a smaže soubory vytvořené v kole. */
  async undoLast(): Promise<string> {
    const cp = this.stack.pop();
    if (!cp) return "Žádný checkpoint k obnovení.";
    const r = await git(["checkout", cp.ref, "--", "."]);
    for (const rel of cp.created) {
      const uri = resolveInWorkspace(rel);
      if (await fileExists(uri)) await vscode.workspace.fs.delete(uri);
    }
    return r.ok ? `Kolo ${cp.turn} vráceno (checkpoint ${cp.ref.slice(0, 7)}).` : `git checkout selhal: ${r.out}`;
  }
}
