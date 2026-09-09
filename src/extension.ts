import * as vscode from "vscode";
import { ApprovalService } from "./agent/Approvals";
import { Controller } from "./agent/Controller";
import { ClipboardBridge } from "./clipboard/ClipboardBridge";
import { ReviewManager } from "./review/ReviewManager";
import { Checkpoint } from "./safety/Checkpoint";
import { Session } from "./session/Session";
import { SidebarView } from "./ui/SidebarView";
import { IndicatorState, TaskbarIndicator } from "./ui/TaskbarIndicator";

export function activate(context: vscode.ExtensionContext): void {
  const session = new Session();
  const review = new ReviewManager();
  const clipboard = new ClipboardBridge();
  const checkpoint = new Checkpoint();
  const approvals = new ApprovalService();
  const controller = new Controller(session, review, clipboard, checkpoint, approvals);
  const sidebar = new SidebarView(controller, context.extensionUri);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "whisper.sidebar.focus";
  const renderStatus = () => {
    const s = session.current;
    const map: Record<string, string> = {
      waitingForReply: `$(clock) Whisper: kolo ${s?.turn} – vlož prompt do chatu`,
      executing: "$(gear~spin) Whisper: provádím akce",
      awaitingUser: "$(question) Whisper: model se ptá",
      done: "$(check) Whisper: hotovo",
      composing: "$(loading~spin) Whisper: sestavuji prompt",
    };
    const pendingApprovals = approvals.pendingRequests.length;
    status.text = pendingApprovals
      ? `$(shield) Whisper: ${pendingApprovals} ke schválení`
      : s
        ? (map[s.state] ?? `$(comment) Whisper: ${s.state}`)
        : "$(comment) Whisper";
    status.backgroundColor = pendingApprovals || s?.state === "awaitingUser" ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    const pending = review.pendingFiles.length;
    status.tooltip = pending ? `${pending} souborů čeká na schválení změn` : "Whisper Agent";
    status.show();

    // hlavní panel Windows + odznak na ikoně panelu
    const attention = pendingApprovals + (s?.state === "awaitingUser" ? 1 : 0);
    const state: IndicatorState = attention
      ? "attention"
      : s?.state === "waitingForReply"
        ? "waiting"
        : s?.state === "executing"
          ? "executing"
          : s?.state === "done"
            ? "done"
            : "idle";
    taskbar.set(state);
    sidebar.setBadge(attention, attention === 1 && s?.state === "awaitingUser" && !pendingApprovals ? "Model se ptá" : `${attention} ke schválení`);
  };
  const taskbar = new TaskbarIndicator(vscode.workspace.workspaceFolders?.[0]?.name ?? "");
  session.onDidChange(renderStatus);
  review.onDidChange(renderStatus);
  approvals.onDidChange(renderStatus);
  renderStatus();

  const cmd = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);

  context.subscriptions.push(
    session,
    review,
    clipboard,
    controller,
    approvals,
    status,
    { dispose: () => taskbar.dispose() },
    vscode.window.registerWebviewViewProvider(SidebarView.viewId, sidebar, { webviewOptions: { retainContextWhenHidden: true } }),

    cmd("whisper.newTask", async () => {
      const task = await vscode.window.showInputBox({
        title: "Whisper Agent – nový úkol",
        prompt: "Co má agent udělat? (/plan pro režim s checklistem, /název-skillu pro skill)",
        placeHolder: "Např. Přidej validaci e-mailu do registračního formuláře",
        ignoreFocusOut: true,
      });
      if (task?.trim()) await controller.submit(task.trim());
    }),
    cmd("whisper.pasteReply", async () => {
      const text = await vscode.env.clipboard.readText();
      if (!ClipboardBridge.looksLikeReply(text, clipboard.currentPrompt)) {
        const pick = await vscode.window.showWarningMessage("Schránka neobsahuje blok <whisper>…</whisper>. Použít obsah přesto?", "Použít");
        if (pick !== "Použít") return;
      }
      controller.submitReply(text);
    }),
    cmd("whisper.copyPromptAgain", () => controller.copyPromptAgain()),
    cmd("whisper.showPrompt", () => controller.showPrompt()),
    cmd("whisper.showTranscript", () => controller.showTranscript()),
    cmd("whisper.resendContext", () => controller.resendContext()),
    cmd("whisper.undoTurn", () => controller.undoTurn()),
    cmd("whisper.abort", () => controller.abort()),
    cmd("whisper.suggest", () => controller.runSuggest()),
    cmd("whisper.reloadSkills", () => controller.reloadSkills()),
    cmd("whisper.toggleAutoApprove", () => approvals.setMode(approvals.mode === "auto" ? "ask" : "auto")),

    cmd("whisper.review.next", async () => {
      if (!(await review.goToNext())) void vscode.window.showInformationMessage("Žádné změny ke schválení.");
    }),
    cmd("whisper.review.acceptHunk", async (path: string, i: number) => {
      await review.accept(path, i);
      await review.goToNext({ path, index: i });
    }),
    cmd("whisper.review.rejectHunk", async (path: string, i: number) => {
      await review.reject(path, i);
      await review.goToNext({ path, index: i });
    }),
    cmd("whisper.review.acceptFile", (path: string) => review.accept(path)),
    cmd("whisper.review.rejectFile", (path: string) => review.reject(path)),
    cmd("whisper.review.acceptAll", () => review.acceptAll()),
    cmd("whisper.review.rejectAll", () => review.rejectAll()),
    cmd("whisper.review.openDiff", (path: string) => review.openDiff(path)),
  );

  void controller.resume();
}

export function deactivate(): void {
  /* subscriptions se uklidí samy */
}
