import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SelectionAnchor, SelectionRequest } from './types';
import { toAnchor } from './types';

export function isSupportedDocument(document: vscode.TextDocument): boolean {
  return document.uri.scheme === 'file';
}

export function requestFromEditor(
  editor: vscode.TextEditor,
  options: { allowCurrentLine?: boolean } = {},
): SelectionRequest | undefined {
  if (!isSupportedDocument(editor.document)) {
    return undefined;
  }
  let selection = editor.selection;
  if (selection.isEmpty) {
    if (!options.allowCurrentLine) {
      return undefined;
    }
    const line = editor.document.lineAt(selection.active.line);
    selection = new vscode.Selection(line.range.start, line.range.end);
  }
  return requestFromRange(editor.document, selection);
}

export function requestFromRange(
  document: vscode.TextDocument,
  selection: vscode.Selection | vscode.Range,
): SelectionRequest {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const selectedText = document.getText(selection);
  const relative = folder
    ? vscode.workspace.asRelativePath(document.uri, false)
    : path.basename(document.uri.fsPath);

  return {
    uri: document.uri.toString(),
    documentVersion: document.version,
    fileName: path.basename(document.uri.fsPath),
    relativePath: relative.replace(/\\/g, '/'),
    absolutePath: document.uri.fsPath,
    languageId: document.languageId,
    startLine: selection.start.line + 1,
    endLine: selection.end.line + 1,
    startCharacter: selection.start.character,
    endCharacter: selection.end.character,
    selectedText,
    workspaceRoot: folder?.uri.fsPath,
    workspaceName: folder?.name,
  };
}

export async function requestFromAnchor(anchor: SelectionAnchor): Promise<SelectionRequest | undefined> {
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(anchor.uri));
    if (!isSupportedDocument(document)) {
      return undefined;
    }
    const startLine = clamp(anchor.startLine - 1, 0, document.lineCount - 1);
    const endLine = clamp(anchor.endLine - 1, startLine, document.lineCount - 1);
    const startCharacter = clamp(anchor.startCharacter, 0, document.lineAt(startLine).text.length);
    const endCharacter = clamp(anchor.endCharacter, 0, document.lineAt(endLine).text.length);
    const range = new vscode.Range(
      new vscode.Position(startLine, startCharacter),
      new vscode.Position(endLine, endCharacter),
    );
    if (range.isEmpty) {
      const line = document.lineAt(startLine);
      return requestFromRange(document, line.range);
    }
    return requestFromRange(document, range);
  } catch {
    return undefined;
  }
}

export function anchorFromCommandArgs(args: unknown[]): SelectionAnchor | undefined {
  const candidate = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (!isRecord(candidate)) {
    return undefined;
  }
  if (
    typeof candidate.uri !== 'string' ||
    typeof candidate.startLine !== 'number' ||
    typeof candidate.endLine !== 'number' ||
    typeof candidate.startCharacter !== 'number' ||
    typeof candidate.endCharacter !== 'number'
  ) {
    return undefined;
  }
  return {
    uri: candidate.uri,
    documentVersion:
      typeof candidate.documentVersion === 'number' ? candidate.documentVersion : 0,
    startLine: candidate.startLine,
    endLine: candidate.endLine,
    startCharacter: candidate.startCharacter,
    endCharacter: candidate.endCharacter,
  };
}

export function anchorOf(request: SelectionRequest): SelectionAnchor {
  return toAnchor(request);
}

export function isSameEditorSelection(
  editor: vscode.TextEditor | undefined,
  request: SelectionRequest,
): boolean {
  if (!editor || editor.document.uri.toString() !== request.uri) {
    return false;
  }
  if (editor.document.version !== request.documentVersion) {
    return false;
  }
  const selection = editor.selection;
  return (
    selection.start.line + 1 === request.startLine &&
    selection.start.character === request.startCharacter &&
    selection.end.line + 1 === request.endLine &&
    selection.end.character === request.endCharacter
  );
}

export function currentAnchor(): SelectionAnchor | undefined {
  const editor = vscode.window.activeTextEditor;
  const request = editor ? requestFromEditor(editor, { allowCurrentLine: true }) : undefined;
  return request ? anchorOf(request) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}
