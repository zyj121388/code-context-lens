import * as vscode from 'vscode';
import { ExplainerService } from './analysis/explainer';
import { CommandManager } from './commands';
import { initLogger, logError, logInfo } from './logger';
import { SelectionController } from './selectionController';
import { requestFromEditor } from './selection';
import { ExplanationPanel } from './ui/panel';
import { LensHoverProvider } from './ui/hoverProvider';

export function activate(context: vscode.ExtensionContext): void {
  initLogger(context);
  logInfo('Activating Code Context Lens');

  const service = new ExplainerService(context.secrets);
  const panel = new ExplanationPanel(context.extensionUri, service);
  const hover = new LensHoverProvider(service, [{ scheme: 'file' }]);
  const controller = new SelectionController(service, hover, panel);
  const commands = new CommandManager(service, panel);
  commands.register();

  context.subscriptions.push(service, panel, hover, controller, commands);

  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    context.subscriptions.push(
      vscode.commands.registerCommand('codeContextLens.__testArmHover', () => {
        const editor = vscode.window.activeTextEditor;
        const request = editor ? requestFromEditor(editor) : undefined;
        if (!request) {
          throw new Error('No selection available for hover test.');
        }
        hover.arm(request);
        return request.uri;
      }),
      vscode.commands.registerCommand('codeContextLens.__testAutoExplain', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          throw new Error('No active editor for auto explanation test.');
        }
        await controller.fireAutoForTest(editor);
      }),
      vscode.commands.registerCommand('codeContextLens.__testHoverState', () => ({
        served: hover.hoverServedCount,
      })),
    );
  }

  void service
    .getProviderInfo()
    .then((info) => {
      logInfo(
        `Provider: ${info.kind} ${info.available ? 'available' : 'unavailable'} (${info.model})`,
      );
    })
    .catch((error: unknown) => logError('Unable to resolve provider during activation', error));
}

export function deactivate(): void {
  // All resources are disposed through context.subscriptions.
}
