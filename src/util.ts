import * as path from "path";
import * as vscode from "vscode";

export function workspaceRoot(): vscode.Uri {
  const f = vscode.workspace.workspaceFolders?.[0];
  if (!f) throw new Error("Není otevřený žádný workspace.");
  return f.uri;
}

export function workspaceName(): string {
  return vscode.workspace.workspaceFolders?.[0]?.name ?? "workspace";
}

/** Převede relativní cestu na Uri uvnitř workspace; odmítne únik ven. */
export function resolveInWorkspace(rel: string): vscode.Uri {
  const root = workspaceRoot();
  const clean = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  const abs = path.resolve(root.fsPath, clean);
  const relBack = path.relative(root.fsPath, abs);
  if (relBack.startsWith("..") || path.isAbsolute(relBack)) {
    throw new Error(`Cesta "${rel}" leží mimo workspace.`);
  }
  return vscode.Uri.file(abs);
}

export function toRel(uri: vscode.Uri): string {
  return path.relative(workspaceRoot().fsPath, uri.fsPath).replace(/\\/g, "/");
}

export function cfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration("whisper").get<T>(key, fallback);
}

export async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export async function readText(uri: vscode.Uri): Promise<string> {
  // preferuj otevřený (možná neuložený) dokument
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString("utf8");
}

export async function writeText(uri: vscode.Uri, text: string): Promise<void> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) {
    const edit = new vscode.WorkspaceEdit();
    const full = new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length));
    edit.replace(uri, full, text);
    await vscode.workspace.applyEdit(edit);
    await open.save();
    return;
  }
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
}
