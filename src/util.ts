import * as path from "path";
import * as vscode from "vscode";
import { relOf, resolveRel, RootFolder, uniqueRoots } from "./protocol/roots";
import { applyEol, decodeBytes, detectEncoding, encodeText, FileEncoding, normalizeEncoding, toLf } from "./tools/encoding";

/** První složka workspace: tam žije stav agenta (.whisper/) a tam běží příkazy bez cwd. */
export function workspaceRoot(): vscode.Uri {
  const f = vscode.workspace.workspaceFolders?.[0];
  if (!f) throw new Error("Není otevřený žádný workspace.");
  return f.uri;
}

/** Všechny složky workspace s jedinečnými názvy (multi-root: cesty jimi začínají). */
export function workspaceFolders(): RootFolder[] {
  return uniqueRoots((vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, fsPath: f.uri.fsPath })));
}

export function isMultiRoot(): boolean {
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
}

export function workspaceName(): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length > 1) return vscode.workspace.name ?? folders.map((f) => f.name).join(" + ");
  return folders[0]?.name ?? "workspace";
}

/** Převede relativní cestu na Uri uvnitř workspace (multi-root: `složka/cesta`); odmítne únik ven. */
export function resolveInWorkspace(rel: string): vscode.Uri {
  return vscode.Uri.file(resolveRel(rel, workspaceFolders()).fsPath);
}

/** Relativní cesta ve workspace; u souboru mimo workspace vrátí undefined. */
export function tryToRel(uri: vscode.Uri): string | undefined {
  return uri.scheme === "file" ? relOf(uri.fsPath, workspaceFolders()) : undefined;
}

export function toRel(uri: vscode.Uri): string {
  return tryToRel(uri) ?? path.relative(workspaceRoot().fsPath, uri.fsPath).replace(/\\/g, "/");
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

/** Jak je soubor uložený (kódování, BOM, konce řádků); neexistující soubor → výchozí nastavení. */
export async function fileEncodingOf(uri: vscode.Uri): Promise<FileEncoding> {
  const fallback = cfg<string>("files.fallbackEncoding", "windows-1250");
  try {
    return detectEncoding(Buffer.from(await vscode.workspace.fs.readFile(uri)), fallback);
  } catch {
    // nový soubor: konce řádků podle files.eol editoru, "auto" = LF (git si CRLF vyřeší sám)
    const eolSetting = vscode.workspace.getConfiguration("files", uri).get<string>("eol", "auto");
    return {
      encoding: normalizeEncoding(cfg<string>("files.defaultEncoding", "utf8")),
      bom: false,
      eol: eolSetting === "\r\n" ? "crlf" : "lf",
    };
  }
}

/** Obsah souboru; kódování se pozná z bajtů, konce řádků se sjednotí na LF. */
export async function readText(uri: vscode.Uri): Promise<string> {
  // preferuj otevřený (možná neuložený) dokument
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return toLf(open.getText());
  const buf = Buffer.from(await vscode.workspace.fs.readFile(uri));
  return toLf(decodeBytes(buf, detectEncoding(buf, cfg<string>("files.fallbackEncoding", "windows-1250")).encoding));
}

/** Zápis; u existujícího souboru se zachová jeho kódování, BOM i konce řádků. */
export async function writeText(uri: vscode.Uri, text: string): Promise<void> {
  const enc = await fileEncodingOf(uri);
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) {
    // otevřený dokument: konce řádků řídí editor (document.eol), obsah tedy vkládáme s LF
    const edit = new vscode.WorkspaceEdit();
    const full = new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length));
    edit.replace(uri, full, toLf(text));
    await vscode.workspace.applyEdit(edit);
    await open.save();
    return;
  }
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
  await vscode.workspace.fs.writeFile(uri, encodeText(applyEol(text, enc.eol), enc));
}
