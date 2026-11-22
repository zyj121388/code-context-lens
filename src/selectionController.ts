import * as vscode from 'vscode';
import { readConfig } from './config';
import { logError } from './logger';
import type { ExplainerService } from './analysis/explainer';
import type { AnalysisResult, DeepStatus, SelectionRequest } from './types';
import { requestKey } from './types';
import type { ExplanationPanel } from './ui/panel';
import type { LensHoverProvider } from './ui/hoverProvider';
import { isSameEditorSelection, isSupportedDocument, requestFromEditor } from './selection';

interface AutoRequest {
  editor: vscode.TextEditor;
  request: SelectionRequest;
  at: number;
}

export class SelectionController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusBar: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | undefined;
  private lastAuto: AutoRequest | undefined;
  private lastSelectionLabel = '';
  private showStatusBar = true;
  private disposed = false;

  public constructor(
    private readonly service: ExplainerService,
    private readonly hover: LensHoverProvider,
    private readonly panel: ExplanationPanel,
  ) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 88);
    this.statusBar.command = 'codeContextLens.toggleAuto';
    this.statusBar.name = '代码上下文透镜';
    this.disposables.push(this.statusBar);
    this.showStatusBar = readConfig().showStatusBar;

    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((event) => this.onSelectionChanged(event)),
      vscode.window.onDidChangeActiveTextEditor(() => this.cancelTimer()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.lastAuto?.request.uri === event.document.uri.toString()) {
          this.hover.clear();
        }
        this.cancelTimer();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('codeContextLens')) {
          this.syncStatusBar();
        }
      }),
      this.service.onDidDeepReady((result) => this.onDeepReady(result)),
      this.service.onDidDeepStatus((status) => this.onDeepStatus(status)),
    );

    this.syncStatusBar();
  }

  public dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  /** Used only by the extension-development integration test hook. */
  public async fireAutoForTest(editor: vscode.TextEditor): Promise<void> {
    const request = requestFromEditor(editor);
    if (!request) {
      throw new Error('No selection available for auto explanation test.');
    }
    await this.fireAuto(editor, request);
  }

  private onSelectionChanged(event: vscode.TextEditorSelectionChangeEvent): void {
    if (this.disposed) {
      return;
    }
    this.cancelTimer();

    const editor = event.textEditor;
    if (!isSupportedDocument(editor.document)) {
      this.lastSelectionLabel = '';
      this.syncStatusBar();
      return;
    }

    if (
      event.kind !== vscode.TextEditorSelectionChangeKind.Mouse &&
      event.kind !== vscode.TextEditorSelectionChangeKind.Keyboard
    ) {
      return;
    }

    const config = readConfig();
    if (!config.enabled || !config.autoPopup) {
      this.lastSelectionLabel = '';
      this.syncStatusBar();
      return;
    }

    const selection = editor.selection;
    if (selection.isEmpty || event.selections.length > 1) {
      this.lastSelectionLabel = '';
      this.syncStatusBar();
      return;
    }

    const selectedText = editor.document.getText(selection);
    if (selectedText.trim().length < config.minSelectionChars) {
      this.lastSelectionLabel = '';
      this.syncStatusBar();
      return;
    }

    const request = requestFromEditor(editor);
    if (!request) {
      return;
    }

    const lines = request.endLine - request.startLine + 1;
    this.lastSelectionLabel = `已选中 ${lines} 行`;
    this.setStatus(
      `$(selection) ${this.lastSelectionLabel} · 准备解释…`,
      '松开选区后会结合项目上下文解释',
    );

    this.timer = setTimeout(() => {
      void this.fireAuto(editor, request);
    }, config.delayMs);
    this.timer.unref?.();
  }

  private async fireAuto(editor: vscode.TextEditor, request: SelectionRequest): Promise<void> {
    if (this.disposed || vscode.window.activeTextEditor !== editor) {
      return;
    }
    if (!isSameEditorSelection(editor, request)) {
      return;
    }
    const config = readConfig();
    if (!config.enabled || !config.autoPopup) {
      return;
    }

    this.setStatus(
      '$(sync~spin) 代码透镜：正在读取项目结构…',
      '正在收集文件大纲、依赖和关联文件',
    );

    try {
      await this.service.prepare(request);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      logError('Unable to prepare auto explanation', error);
      this.setStatus('$(warning) 代码透镜：读取上下文失败', '点击状态栏可暂停自动弹窗');
      return;
    }

    if (
      this.disposed ||
      vscode.window.activeTextEditor !== editor ||
      !isSameEditorSelection(editor, request)
    ) {
      return;
    }

    this.lastAuto = { editor, request, at: Date.now() };
    if (config.popupStyle === 'panel') {
      this.panel.show(request);
      this.setStatus('$(book) 代码透镜：完整解读已打开', '面板会显示结构速览与 AI 深度解读');
      return;
    }

    this.hover.arm(request);
    try {
      await vscode.commands.executeCommand('editor.action.showHover');
    } catch (error) {
      logError('editor.action.showHover failed, falling back to panel', error);
      this.panel.show(request);
      return;
    }

    if (config.autoDeepAnalysis) {
      const started = await this.service.startBackgroundDeep(request, config);
      if (started) {
        this.setStatus(
          '$(sync~spin) 代码透镜：正在生成深度解读…',
          '小窗会先显示结构速览，AI 完成后自动刷新',
        );
      } else {
        this.setStatus('$(sparkle) 代码透镜：结构速览已就绪', '配置模型后可获得 AI 深度解读');
      }
    } else {
      this.setStatus('$(sparkle) 代码透镜：结构速览已就绪', '点击代码或选中文本可继续查看');
    }
  }

  private onDeepReady(result: AnalysisResult): void {
    if (this.disposed) {
      return;
    }
    const config = readConfig();
    this.lastSelectionLabel = '';
    this.setStatus(
      '$(check) 代码透镜：深度解读已就绪',
      '点击可暂停/恢复自动弹窗；Ctrl+Alt+E 打开完整解读',
    );

    const last = this.lastAuto;
    if (
      !config.refreshHoverWhenReady ||
      config.popupStyle !== 'hover' ||
      !last ||
      this.panel.isActive ||
      vscode.window.activeTextEditor !== last.editor ||
      requestKey(last.request) !== result.requestKey ||
      !isSameEditorSelection(vscode.window.activeTextEditor, result.context.request)
    ) {
      return;
    }

    this.hover.arm(result.context.request);
    void Promise.resolve(vscode.commands.executeCommand('editor.action.showHover')).catch(
      (error: unknown) => {
        logError('Unable to refresh hover after deep analysis', error);
      },
    );
  }

  private onDeepStatus(status: DeepStatus): void {
    if (this.disposed) {
      return;
    }
    if (status.state === 'streaming' || status.state === 'warming') {
      this.setStatus(
        '$(sync~spin) 代码透镜：AI 正在结合项目上下文生成…',
        status.message,
      );
    } else if (status.state === 'error') {
      this.setStatus('$(warning) 代码透镜：深度解读失败', status.message ?? '点击查看详情');
    } else if (status.state === 'unavailable') {
      this.setStatus('$(sparkle) 代码透镜：本地结构分析', status.message);
    } else if (status.state === 'done') {
      this.setStatus('$(check) 代码透镜：深度解读已就绪', status.message);
    } else {
      this.syncStatusBar();
    }
  }

  private syncStatusBar(): void {
    const config = readConfig();
    this.showStatusBar = config.showStatusBar;
    if (!config.showStatusBar) {
      this.statusBar.hide();
      return;
    }
    if (!config.enabled) {
      this.setStatus('$(circle-slash) 自动解释已关闭', '手动命令仍可用；在设置中重新开启');
      return;
    }
    if (!config.autoPopup) {
      this.setStatus('$(debug-pause) 代码透镜已暂停', '点击恢复“选中即解释”');
      return;
    }
    if (this.lastSelectionLabel) {
      this.setStatus(`$(selection) ${this.lastSelectionLabel}`, '选中代码后自动解释');
    } else {
      this.setStatus('$(sparkle) 代码透镜', '选中代码即可结合项目上下文解释');
    }
  }

  private setStatus(text: string, tooltip?: string): void {
    if (!this.showStatusBar) {
      this.statusBar.hide();
      return;
    }
    this.statusBar.text = text;
    this.statusBar.tooltip = tooltip ?? text;
    this.statusBar.show();
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
