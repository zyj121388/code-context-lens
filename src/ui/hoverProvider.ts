import * as vscode from 'vscode';
import { readConfig } from '../config';
import { logError } from '../logger';
import type { ExplainerService } from '../analysis/explainer';
import type { SelectionRequest } from '../types';
import { buildHoverMarkdown } from './hoverMarkdown';

interface ArmedHover {
  request: SelectionRequest;
  range: vscode.Range;
  expiresAt: number;
}

export class LensHoverProvider implements vscode.HoverProvider, vscode.Disposable {
  private armed: ArmedHover | undefined;
  private readonly disposable: vscode.Disposable;
  public hoverServedCount = 0;

  public constructor(
    private readonly service: ExplainerService,
    selector: vscode.DocumentSelector,
  ) {
    this.disposable = vscode.languages.registerHoverProvider(selector, this);
  }

  public arm(request: SelectionRequest): void {
    this.armed = {
      request,
      range: rangeFromRequest(request),
      expiresAt: Date.now() + 3000,
    };
  }

  public clear(): void {
    this.armed = undefined;
  }

  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const armed = this.armed;
    if (!armed) {
      return undefined;
    }
    if (document.uri.toString() !== armed.request.uri) {
      return undefined;
    }
    if (Date.now() > armed.expiresAt) {
      this.armed = undefined;
      return undefined;
    }
    if (!armed.range.contains(position) && !isLineInside(position.line, armed.request)) {
      return undefined;
    }

    this.armed = undefined;

    try {
      const result = await this.service.prepare(armed.request, token);
      if (token.isCancellationRequested) {
        return undefined;
      }
      const config = readConfig();
      const provider = await this.service.getProviderInfo();
      const deepPending =
        result.source === 'local' &&
        provider.kind !== 'local' &&
        provider.available &&
        config.autoDeepAnalysis;

      const markdown = new vscode.MarkdownString(
        buildHoverMarkdown(result, { deepPending, provider }),
      );
      markdown.isTrusted = true;
      markdown.supportHtml = false;
      markdown.supportThemeIcons = false;

      this.hoverServedCount += 1;
      return new vscode.Hover(markdown, rangeFromRequest(armed.request));
    } catch (error) {
      logError('Unable to build hover explanation', error);
      return undefined;
    }
  }

  public dispose(): void {
    this.disposable.dispose();
    this.armed = undefined;
  }
}

export function rangeFromRequest(request: SelectionRequest): vscode.Range {
  return new vscode.Range(
    new vscode.Position(Math.max(0, request.startLine - 1), Math.max(0, request.startCharacter)),
    new vscode.Position(Math.max(0, request.endLine - 1), Math.max(0, request.endCharacter)),
  );
}

function isLineInside(line: number, request: SelectionRequest): boolean {
  return line >= request.startLine - 1 && line <= request.endLine - 1;
}
