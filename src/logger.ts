import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function initLogger(context: vscode.ExtensionContext): void {
  if (!channel) {
    channel = vscode.window.createOutputChannel('代码上下文透镜', { log: true });
    context.subscriptions.push(channel);
  }
}

export function logInfo(message: string): void {
  channel?.info(message);
}

export function logWarn(message: string): void {
  channel?.warn(message);
}

export function logError(message: string, error?: unknown): void {
  if (error === undefined) {
    channel?.error(message);
    return;
  }
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  channel?.error(`${message}\n${detail}`);
}

export function showOutput(): void {
  channel?.show(true);
}
