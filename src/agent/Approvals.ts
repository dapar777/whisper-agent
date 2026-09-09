import * as vscode from "vscode";
import { nowId } from "../protocol/text";
import { cfg } from "../util";

export type ApprovalKind = "command" | "delete";

export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  /** příkaz nebo cesta */
  text: string;
  cwd?: string;
  at: string;
  decision?: "allow" | "deny" | "auto";
}

/**
 * Schvalování příkazů a mazání: místo modálních oken karta v sidebaru
 * (s náhradní notifikací, když sidebar není vidět). Režim `auto` schválí vše
 * kromě denylistu; „vždy povolit“ přidá regulární výraz do nastavení.
 */
export class ApprovalService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly pending = new Map<string, { req: ApprovalRequest; resolve: (ok: boolean) => void }>();
  readonly history: ApprovalRequest[] = [];

  get mode(): "ask" | "auto" {
    return cfg<"ask" | "auto">("run.approval", "ask");
  }

  async setMode(mode: "ask" | "auto"): Promise<void> {
    await vscode.workspace.getConfiguration("whisper").update("run.approval", mode, vscode.ConfigurationTarget.Workspace);
    this.emitter.fire();
  }

  get pendingRequests(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.req);
  }

  /** Vrátí true, když smí akce proběhnout. V režimu auto se příkazy schválí bez dotazu. */
  request(kind: ApprovalKind, text: string, cwd?: string): Promise<boolean> {
    const req: ApprovalRequest = { id: nowId(), kind, text, cwd, at: new Date().toISOString() };
    if (kind === "command" && this.mode === "auto") {
      req.decision = "auto";
      this.history.push(req);
      this.emitter.fire();
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      this.pending.set(req.id, { req, resolve });
      this.emitter.fire();
      // žádné vyskakovací okno: karta v panelu Whisper, panel se otevře, stavový řádek upozorní
      void vscode.commands.executeCommand("whisper.sidebar.focus");
      vscode.window.setStatusBarMessage(`$(shield) Whisper čeká na schválení: ${text.slice(0, 60)}`, 15000);
    });
  }

  /** Aktuální výjimky (regulární výrazy) se zdrojem. */
  allowPatterns(): { pattern: string; scope: "global" | "workspace" }[] {
    const insp = vscode.workspace.getConfiguration("whisper").inspect<string[]>("run.allowPatterns");
    return [
      ...(insp?.globalValue ?? []).map((p) => ({ pattern: p, scope: "global" as const })),
      ...[...(insp?.workspaceValue ?? []), ...(insp?.workspaceFolderValue ?? [])].map((p) => ({ pattern: p, scope: "workspace" as const })),
    ];
  }

  async removeAllowPattern(pattern: string, scope: "global" | "workspace"): Promise<void> {
    const conf = vscode.workspace.getConfiguration("whisper");
    const insp = conf.inspect<string[]>("run.allowPatterns");
    const current = (scope === "global" ? insp?.globalValue : insp?.workspaceValue) ?? [];
    await conf.update(
      "run.allowPatterns",
      current.filter((p) => p !== pattern),
      scope === "global" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace,
    );
    this.emitter.fire();
  }

  /** Přepne do auto a povolí všechny čekající požadavky na příkazy. */
  async switchToAuto(): Promise<void> {
    await this.setMode("auto");
    for (const [id, p] of [...this.pending]) {
      if (p.req.kind === "command") await this.decide(id, true);
    }
  }

  /** Rozhodnutí z UI; `alwaysPattern` přidá regulární výraz do allow-listu workspace. */
  async decide(id: string, allow: boolean, alwaysPattern?: string): Promise<void> {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.req.decision = allow ? "allow" : "deny";
    this.history.push(p.req);
    if (allow && alwaysPattern?.trim()) await this.addAllowPattern(alwaysPattern.trim());
    p.resolve(allow);
    this.emitter.fire();
  }

  /** Přidá regulární výraz do allow-listu; `global` = uživatelská nastavení (všechny projekty). */
  async addAllowPattern(pattern: string, global = false): Promise<void> {
    try {
      new RegExp(pattern);
    } catch {
      void vscode.window.showWarningMessage(`Neplatný regulární výraz: ${pattern}`);
      return;
    }
    const conf = vscode.workspace.getConfiguration("whisper");
    const inspected = conf.inspect<string[]>("run.allowPatterns");
    const current = (global ? inspected?.globalValue : inspected?.workspaceValue) ?? [];
    if (!current.includes(pattern)) {
      await conf.update("run.allowPatterns", [...current, pattern], global ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace);
    }
    this.emitter.fire();
  }

  dispose(): void {
    for (const p of this.pending.values()) p.resolve(false);
    this.pending.clear();
    this.emitter.dispose();
  }
}
