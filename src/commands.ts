import * as vscode from 'vscode';
import { providerDisplayName, readConfig, resolveProvider, secretKey } from './config';
import { logError, logInfo } from './logger';
import { streamChatCompletion } from './llm/openAiCompatible';
import type { ExplainerService } from './analysis/explainer';
import type { ExplanationPanel } from './ui/panel';
import type { ResolvedProviderKind, SelectionRequest } from './types';
import {
  anchorFromCommandArgs,
  requestFromAnchor,
  requestFromEditor,
} from './selection';

interface ConfigureItem extends vscode.QuickPickItem {
  value:
    | 'auto'
    | 'deepseek'
    | 'openai'
    | 'ollama'
    | 'local'
    | 'test'
    | 'clear'
    | 'settings';
}

interface RelatedFileArg {
  path?: string;
  line?: number;
}

export class CommandManager implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly service: ExplainerService,
    private readonly panel: ExplanationPanel,
  ) {}

  public register(): void {
    const commands: Array<[string, (...args: unknown[]) => unknown]> = [
      ['codeContextLens.explainSelection', (...args) => this.explainSelection(args)],
      ['codeContextLens.openFullExplanation', (...args) => this.openFullExplanation(args)],
      ['codeContextLens.reanalyze', (...args) => this.reanalyze(args)],
      ['codeContextLens.copyExplanation', (...args) => this.copyExplanation(args)],
      ['codeContextLens.openRelatedFile', (...args) => this.openRelatedFile(args)],
      ['codeContextLens.configure', () => this.configure()],
      ['codeContextLens.testProvider', () => this.testProvider()],
      ['codeContextLens.toggleAuto', () => this.toggleAuto()],
      ['codeContextLens.clearCache', () => this.clearCache()],
    ];

    for (const [id, handler] of commands) {
      this.disposables.push(vscode.commands.registerCommand(id, handler));
    }
  }

  public dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private async explainSelection(args: unknown[]): Promise<void> {
    const request = await this.resolveRequest(args, true, true);
    if (!request) {
      return;
    }
    this.panel.show(request);
  }

  private async openFullExplanation(args: unknown[]): Promise<void> {
    const request = await this.resolveRequest(args, true, false);
    if (!request) {
      return;
    }
    this.panel.show(request);
  }

  private async reanalyze(args: unknown[]): Promise<void> {
    const request = await this.resolveRequest(args, true, false);
    if (!request) {
      return;
    }
    this.service.invalidate(request);
    this.panel.show(request);
  }

  private async copyExplanation(args: unknown[]): Promise<void> {
    const request = await this.resolveRequest(args, true, false);
    if (!request) {
      return;
    }
    try {
      const cached = this.service.getCached(request);
      const result =
        cached ??
        (await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: '代码透镜：正在生成解读',
            cancellable: false,
          },
          async () => await this.service.prepare(request),
        ));
      await vscode.env.clipboard.writeText(result.markdown);
      void vscode.window.showInformationMessage('代码解读已复制到剪贴板。');
    } catch (error) {
      logError('Unable to copy explanation', error);
      void vscode.window.showErrorMessage(
        `复制失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async openRelatedFile(args: unknown[]): Promise<void> {
    const candidate = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (!isRelatedFileArg(candidate)) {
      return;
    }
    const filePath = candidate.path;
    if (!filePath) {
      return;
    }
    try {
      const uri = /^[a-z][a-z0-9+.-]*:\/\//i.test(filePath)
        ? vscode.Uri.parse(filePath)
        : vscode.Uri.file(filePath);
      const document = await vscode.workspace.openTextDocument(uri);
      const requestedLine = Number(candidate.line ?? 1);
      const safeRequestedLine = Number.isFinite(requestedLine) ? Math.round(requestedLine) : 1;
      const line = Math.max(0, Math.min(document.lineCount - 1, safeRequestedLine - 1));
      const position = new vscode.Position(line, 0);
      await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
        preview: false,
        selection: new vscode.Range(position, position),
      });
    } catch (error) {
      logError(`Unable to open related file ${filePath}`, error);
      void vscode.window.showWarningMessage(`无法打开文件：${filePath}`);
    }
  }

  private async configure(): Promise<void> {
    const current = readConfig();
    const items: ConfigureItem[] = [
      {
        label: '$(sparkle) 自动选择',
        description: '有 DeepSeek Key 时优先 DeepSeek，其次 OpenAI；都没有时本地分析',
        value: 'auto',
      },
      {
        label: '$(cloud) DeepSeek',
        description: current.provider === 'deepseek' ? '当前引擎' : '推荐：中文理解与性价比好',
        value: 'deepseek',
      },
      {
        label: '$(globe) OpenAI',
        description: current.provider === 'openai' ? '当前引擎' : 'OpenAI 官方或兼容接口',
        value: 'openai',
      },
      {
        label: '$(server) Ollama / 本地兼容接口',
        description: current.provider === 'ollama' ? '当前引擎' : '无需 API Key，数据留在本机',
        value: 'ollama',
      },
      {
        label: '$(chip) 本地结构分析（离线）',
        description: current.provider === 'local' ? '当前引擎' : '不联网，只做静态结构分析',
        value: 'local',
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, value: 'settings' },
      { label: '$(plug) 测试当前模型连接', value: 'test' },
      { label: '$(key) 清除已保存的 API Key', value: 'clear' },
      { label: '$(gear) 打开扩展设置', value: 'settings' },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: '代码透镜：选择解读引擎',
      placeHolder: `当前：${providerDisplayName(current.provider)}`,
      ignoreFocusOut: true,
    });
    if (!picked) {
      return;
    }

    if (picked.value === 'settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'codeContextLens');
      return;
    }
    if (picked.value === 'test') {
      await vscode.commands.executeCommand('codeContextLens.testProvider');
      return;
    }
    if (picked.value === 'clear') {
      await this.clearKeys();
      return;
    }
    if (picked.value === 'auto') {
      await updateSetting('provider', 'auto');
      void vscode.window.showInformationMessage(
        '已切换为自动选择。配置 API Key 后会自动启用深度解读。',
      );
      return;
    }
    if (picked.value === 'local') {
      await updateSetting('provider', 'local');
      void vscode.window.showInformationMessage('已切换为本地结构分析，不会发送任何网络请求。');
      return;
    }

    const kind = picked.value;
    await updateSetting('provider', kind);
    if (kind === 'ollama') {
      const action = await vscode.window.showInformationMessage(
        '已选择 Ollama。默认地址为 http://127.0.0.1:11434/v1，模型 qwen2.5-coder:7b；可在设置中修改。',
        '测试连接',
        '打开设置',
      );
      if (action === '测试连接') {
        await this.testProvider();
      } else if (action === '打开设置') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'codeContextLens');
      }
      return;
    }

    await this.promptForApiKey(kind);
    const action = await vscode.window.showInformationMessage(
      `${providerDisplayName(kind)} 已配置。现在可以选中代码，在小窗中查看 AI 深度解读。`,
      '测试连接',
    );
    if (action === '测试连接') {
      await this.testProvider();
    }
  }

  private async promptForApiKey(kind: ResolvedProviderKind): Promise<void> {
    const existing = await this.service.secrets.get(secretKey(kind));
    const value = await vscode.window.showInputBox({
      title: `代码透镜：${providerDisplayName(kind)} API Key`,
      prompt: existing
        ? '已保存 Key。留空保留现有 Key，输入新值则覆盖。'
        : 'Key 只保存在 VS Code SecretStorage，不会写入 settings.json。',
      placeHolder: existing ? '••••••••（留空保留）' : '粘贴 API Key',
      password: true,
      ignoreFocusOut: true,
      validateInput: (input) => {
        const trimmed = input.trim();
        if (!trimmed && !existing) {
          return '请输入 API Key（或按 Esc 取消）';
        }
        return undefined;
      },
    });

    if (value === undefined) {
      return;
    }
    if (value.trim()) {
      await this.service.secrets.store(secretKey(kind), value.trim());
      logInfo(`Stored API key for ${kind}`);
    }
  }

  private async clearKeys(): Promise<void> {
    const items: Array<vscode.QuickPickItem & { provider: ResolvedProviderKind }> = [
      { label: 'DeepSeek', provider: 'deepseek' },
      { label: 'OpenAI', provider: 'openai' },
      { label: 'Ollama（可选）', provider: 'ollama' },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: '代码透镜：清除 API Key',
      placeHolder: '选择要清除 Key 的提供商',
      ignoreFocusOut: true,
    });
    if (!picked) {
      return;
    }
    await this.service.secrets.delete(secretKey(picked.provider));
    void vscode.window.showInformationMessage(`已清除 ${picked.label} 的 API Key。`);
  }

  private async testProvider(): Promise<void> {
    const config = readConfig();
    const resolution = await resolveProvider(config, this.service.secrets);
    if (resolution.info.kind === 'local' || !resolution.info.available) {
      const action = await vscode.window.showWarningMessage(
        resolution.info.reason ?? '当前没有可用的深度解读模型。',
        '配置模型',
      );
      if (action === '配置模型') {
        await this.configure();
      }
      return;
    }

    const controller = new AbortController();
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `代码透镜：测试 ${resolution.info.label} 连接`,
        cancellable: true,
      },
      async (progress, token) => {
        token.onCancellationRequested(() => controller.abort());
        progress.report({ message: `${resolution.info.model}…` });
        try {
          const answer = await streamChatCompletion({
            baseUrl: resolution.info.baseUrl,
            model: resolution.info.model,
            apiKey: resolution.apiKey,
            messages: [
              {
                role: 'user',
                content: '这是一次连接测试。请只回复：OK',
              },
            ],
            temperature: 0,
            maxTokens: 24,
            timeoutMs: Math.min(config.requestTimeoutMs, 30000),
            signal: controller.signal,
          });
          void vscode.window.showInformationMessage(
            `连接成功：${resolution.info.label} · ${resolution.info.model}。返回：${answer.slice(0, 80)}`,
          );
        } catch (error) {
          if (controller.signal.aborted) {
            return;
          }
          logError('Provider connection test failed', error);
          const message = error instanceof Error ? error.message : String(error);
          const action = await vscode.window.showErrorMessage(`连接失败：${message}`, '配置模型');
          if (action === '配置模型') {
            await this.configure();
          }
        }
      },
    );
  }

  private async toggleAuto(): Promise<void> {
    const config = vscode.workspace.getConfiguration('codeContextLens');
    const next = !config.get<boolean>('autoPopup', true);
    await config.update('autoPopup', next, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(
      next
        ? '代码透镜：已恢复“选中即解释”。'
        : '代码透镜：已暂停自动弹窗。仍可用 Ctrl+Alt+E 或右键菜单解释代码。',
    );
  }

  private async clearCache(): Promise<void> {
    this.service.invalidate();
    void vscode.window.showInformationMessage('代码透镜：本地解读缓存已清除。');
  }

  private async resolveRequest(
    args: unknown[],
    allowCurrentLine: boolean,
    notifyWhenMissing: boolean,
  ): Promise<SelectionRequest | undefined> {
    const anchor = anchorFromCommandArgs(args);
    if (anchor) {
      const fromAnchor = await requestFromAnchor(anchor);
      if (fromAnchor) {
        return fromAnchor;
      }
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      if (notifyWhenMissing) {
        void vscode.window.showWarningMessage('请先在编辑器中选中一段代码。');
      }
      return undefined;
    }
    const request = requestFromEditor(editor, { allowCurrentLine });
    if (!request) {
      if (notifyWhenMissing) {
        void vscode.window.showWarningMessage('请先选中一段代码，再使用代码透镜。');
      }
      return undefined;
    }
    if (allowCurrentLine && editor.selection.isEmpty) {
      void vscode.window.showInformationMessage('未检测到选区，已解释光标所在行。');
    }
    return request;
  }
}

async function updateSetting(key: string, value: string): Promise<void> {
  await vscode.workspace
    .getConfiguration('codeContextLens')
    .update(key, value, vscode.ConfigurationTarget.Global);
}

function isRelatedFileArg(value: unknown): value is RelatedFileArg {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.path === 'string';
}
