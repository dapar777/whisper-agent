import * as vscode from "vscode";
import { ApprovalService } from "../agent/Approvals";
import { DEFAULT_EXCLUDES, parseGitignoreNames } from "../protocol/text";
import { cfg, fileExists, readText, resolveInWorkspace, toRel, workspaceName, workspaceRoot, writeText } from "../util";
import { Host, HostPolicy, RunResult } from "./Host";
import { captureScreenshot } from "./screenshot";
import { spawnCommand } from "./spawn";

const SEV = ["error", "warning", "info", "hint"];

/** Host nad VS Code API. Čte konfiguraci `whisper.*` při každém dotazu; schvalování jde přes ApprovalService. */
export class VsCodeHost implements Host {
  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly approvals: ApprovalService,
  ) {}

  get workspaceName(): string {
    return workspaceName();
  }

  get policy(): HostPolicy {
    // allowPatterns z uživatelských i workspace nastavení se sjednocují (VS Code by jinak pole přepsalo)
    const insp = vscode.workspace.getConfiguration("whisper").inspect<string[]>("run.allowPatterns");
    const allowPatterns = [...new Set([...(insp?.globalValue ?? []), ...(insp?.workspaceValue ?? []), ...(insp?.workspaceFolderValue ?? [])])];
    return {
      autoAllow: cfg<string[]>("run.autoAllow", []),
      allowPatterns,
      deny: cfg<string[]>("run.deny", []),
      protectedPaths: cfg<string[]>("protectedPaths", []),
    };
  }

  assertInside(rel: string): void {
    resolveInWorkspace(rel);
  }

  exists(rel: string): Promise<boolean> {
    return fileExists(resolveInWorkspace(rel));
  }

  readFile(rel: string): Promise<string> {
    return readText(resolveInWorkspace(rel));
  }

  writeFile(rel: string, text: string): Promise<void> {
    return writeText(resolveInWorkspace(rel), text);
  }

  async appendFile(rel: string, text: string): Promise<void> {
    const uri = resolveInWorkspace(rel);
    const current = (await fileExists(uri)) ? await readText(uri) : "";
    await writeText(uri, current + text);
  }

  async deleteFile(rel: string): Promise<void> {
    await vscode.workspace.fs.delete(resolveInWorkspace(rel));
  }

  async listFiles(glob: string, max = 5000): Promise<string[]> {
    const names = new Set(DEFAULT_EXCLUDES);
    try {
      parseGitignoreNames(await readText(vscode.Uri.joinPath(workspaceRoot(), ".gitignore"))).forEach((n) => names.add(n));
    } catch {
      /* bez .gitignore */
    }
    const exclude = `{${[...names].map((n) => `**/${n}/**,**/${n}`).join(",")}}`;
    const uris = await vscode.workspace.findFiles(glob, exclude, max);
    return uris.map(toRel).sort();
  }

  run(command: string, cwdRel: string, timeoutMs: number, probeMs?: number, signal?: AbortSignal): Promise<RunResult> {
    const cwd = cwdRel && cwdRel !== "." ? resolveInWorkspace(cwdRel).fsPath : workspaceRoot().fsPath;
    return spawnCommand(command, cwd, timeoutMs, probeMs, signal);
  }

  async diagnostics(onlyRel?: string, maxLines = 60): Promise<string> {
    const root = workspaceRoot().fsPath.toLowerCase();
    const only = onlyRel ? resolveInWorkspace(onlyRel).fsPath.toLowerCase() : null;
    const lines: string[] = [];
    let total = 0;
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      if (uri.scheme !== "file" || !uri.fsPath.toLowerCase().startsWith(root)) continue;
      if (only && uri.fsPath.toLowerCase() !== only) continue;
      if (/[\\/](node_modules|\.git|dist|out)[\\/]/.test(uri.fsPath)) continue;
      const rel = toRel(uri);
      for (const d of diags) {
        if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
        total++;
        if (lines.length >= maxLines) continue;
        const code = typeof d.code === "object" ? d.code.value : d.code;
        lines.push(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} ${SEV[d.severity]}${code ? ` ${code}` : ""}: ${d.message.split("\n")[0]}`);
      }
    }
    if (total > lines.length) lines.push(`… (${total - lines.length} more)`);
    return lines.join("\n");
  }

  screenshot(rel: string, opts: { window?: string }): Promise<{ width: number; height: number; window?: string }> {
    return captureScreenshot(resolveInWorkspace(rel).fsPath, opts);
  }

  absolutePath(rel: string): string {
    return resolveInWorkspace(rel).fsPath;
  }

  confirmCommand(command: string, cwdRel: string): Promise<boolean> {
    return this.approvals.request("command", command, cwdRel);
  }

  confirmDelete(rel: string): Promise<boolean> {
    return this.approvals.request("delete", rel);
  }

  log(line: string): void {
    this.output.appendLine(line);
  }
}
