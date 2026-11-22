import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { readConfig } from '../config';
import { logError } from '../logger';
import type { ExplainerService } from '../analysis/explainer';
import { ProviderUnavailableError } from '../analysis/explainer';
import type { AnalysisResult, DeepStatus, ProviderInfo, SelectionRequest } from '../types';
import { escapeAttribute, escapeHtml, renderMarkdown } from './markdown';
import { renderProjectLocator } from './projectLocator';

export class ExplanationPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private request: SelectionRequest | undefined;
  private quick: AnalysisResult | undefined;
  private provider: ProviderInfo | undefined;
  private ready = false;
  private runId = 0;
  private deepText = '';
  private deepStatus: DeepStatus = { state: 'idle' };
  private flushTimer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: ExplainerService,
  ) {}

  public get isActive(): boolean {
    return this.panel?.active ?? false;
  }

  public show(request: SelectionRequest): void {
    this.request = request;
    this.quick = undefined;
    this.deepText = '';
    this.deepStatus = { state: 'idle' };
    this.runId += 1;

    if (this.panel) {
      this.panel.title = `代码透镜 · ${request.fileName}`;
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      if (this.ready) {
        this.post({ type: 'reset' });
        void this.render();
      } else {
        this.post({ type: 'reset' });
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'codeContextLens.full',
      `代码透镜 · ${request.fileName}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
      },
    );
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');

    panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        if (this.panel !== panel) {
          return;
        }
        void this.handleMessage(message);
      },
      undefined,
      this.disposables,
    );
    panel.onDidDispose(
      () => {
        if (this.panel !== panel) {
          return;
        }
        this.panel = undefined;
        this.ready = false;
        this.request = undefined;
        this.runId += 1;
        this.clearFlush();
      },
      undefined,
      this.disposables,
    );

    panel.webview.html = this.getHtml(panel.webview);
  }

  public async open(request: SelectionRequest): Promise<void> {
    this.show(request);
  }

  public dispose(): void {
    this.clearFlush();
    this.runId += 1;
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.panel?.dispose();
    this.panel = undefined;
    this.request = undefined;
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      return;
    }
    switch (raw.type) {
      case 'ready':
        this.ready = true;
        if (this.request) {
          await this.render();
        }
        break;
      case 'openFile':
        await openFileAt(String(raw.path ?? ''), Number(raw.line ?? 1));
        break;
      case 'copy': {
        const text = this.quick?.source === 'ai' ? this.quick.markdown : this.deepText || this.quick?.markdown || '';
        if (text) {
          await vscode.env.clipboard.writeText(text);
          this.post({ type: 'toast', message: '解读已复制到剪贴板' });
        }
        break;
      }
      case 'retry':
        if (this.request) {
          this.service.invalidate(this.request);
          this.quick = undefined;
          this.deepText = '';
          this.deepStatus = { state: 'idle' };
          this.post({ type: 'reset' });
          await this.render();
        }
        break;
      case 'configure':
        await vscode.commands.executeCommand('codeContextLens.configure');
        break;
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'codeContextLens');
        break;
      case 'toggleAuto':
        await vscode.commands.executeCommand('codeContextLens.toggleAuto');
        break;
      case 'openExternal': {
        const url = String(raw.url ?? '');
        if (/^https?:\/\//i.test(url)) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }
        break;
      }
      default:
        break;
    }
  }

  private async render(): Promise<void> {
    const request = this.request;
    if (!request || !this.panel) {
      return;
    }
    const run = ++this.runId;
    this.clearFlush();
    this.deepText = '';
    this.deepStatus = { state: 'idle' };

    try {
      const quick = await this.service.prepare(request);
      if (run !== this.runId || !this.panel) {
        return;
      }
      this.quick = quick;
      const provider = await this.service.getProviderInfo();
      this.provider = provider;
      if (run !== this.runId || !this.panel) {
        return;
      }

      const config = readConfig();
      const deepAvailable = provider.kind !== 'local' && provider.available;
      this.post({
        type: 'quick',
        absolutePath: request.absolutePath,
        line: request.startLine,
        filePath: `${request.relativePath}:${request.startLine}-${request.endLine}`,
        metaHtml: renderMeta(quick),
        locatorHtml: renderProjectLocator(quick),
        html: renderMarkdown(quick.markdown),
        contextHtml: renderContext(quick),
        contextChars: quick.context.contextChars,
        deepAvailable,
        providerReason: provider.reason,
        source: quick.source,
        deepHtml: quick.source === 'ai' ? renderMarkdown(quick.markdown) : '',
      });

      if (quick.source === 'ai') {
        this.deepText = quick.markdown;
        this.deepStatus = {
          state: 'done',
          message: '使用已缓存的深度解读',
          provider: quick.model,
          model: quick.model,
        };
        return;
      }

      if (!deepAvailable) {
        this.deepStatus = {
          state: 'unavailable',
          message: provider.reason ?? '未配置模型，当前仅使用本地结构分析。',
        };
        this.post({ type: 'deepUnavailable', message: this.deepStatus.message });
        return;
      }

      this.deepStatus = {
        state: 'warming',
        message: `${provider.label} · ${provider.model} 正在结合项目上下文生成…`,
        provider: provider.label,
        model: provider.model,
      };
      this.post({ type: 'deepStatus', status: this.deepStatus });
      void this.startDeep(request, config, run, provider);
    } catch (error) {
      logError('Unable to render explanation panel', error);
      const message = error instanceof Error ? error.message : String(error);
      this.post({ type: 'deepError', message: `读取项目上下文失败：${message}` });
    }
  }

  private async startDeep(
    request: SelectionRequest,
    config: ReturnType<typeof readConfig>,
    run: number,
    provider: ProviderInfo,
  ): Promise<void> {
    try {
      await this.service.generateDeep(request, config, {
        onStatus: (status) => {
          if (run !== this.runId || !this.panel) {
            return;
          }
          this.deepStatus = status;
          this.post({ type: 'deepStatus', status });
        },
        onToken: (fullText) => {
          if (run !== this.runId || !this.panel) {
            return;
          }
          this.deepText = fullText;
          this.deepStatus = {
            state: 'streaming',
            message: `正在生成… ${fullText.length} 字符`,
            provider: provider.label,
            model: provider.model,
          };
          this.scheduleFlush(run);
        },
        onDone: (result) => {
          if (run !== this.runId || !this.panel) {
            return;
          }
          this.clearFlush();
          this.quick = result;
          this.deepText = result.markdown;
          this.deepStatus = {
            state: 'done',
            message: `${provider.label} 深度解读已生成`,
            provider: provider.label,
            model: provider.model,
          };
          this.post({
            type: 'deepDone',
            html: renderMarkdown(result.markdown),
            message: this.deepStatus.message,
          });
        },
        onError: (error) => {
          if (run !== this.runId || !this.panel) {
            return;
          }
          this.clearFlush();
          this.deepStatus = { state: 'error', message: error.message };
          this.post({ type: 'deepError', message: error.message });
        },
      });
    } catch (error) {
      if (run !== this.runId || !this.panel) {
        return;
      }
      if (error instanceof ProviderUnavailableError) {
        this.deepStatus = { state: 'unavailable', message: error.message };
        this.post({ type: 'deepUnavailable', message: error.message });
        return;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      if (this.deepStatus.state === 'error') {
        return;
      }
      logError('Deep analysis failed in panel', error);
      const message = error instanceof Error ? error.message : String(error);
      this.deepStatus = { state: 'error', message };
      this.post({ type: 'deepError', message });
    }
  }

  private scheduleFlush(run: number): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (run !== this.runId || !this.panel) {
        return;
      }
      this.post({
        type: 'deepChunk',
        html: renderMarkdown(this.deepText),
        length: this.deepText.length,
      });
    }, 120);
  }

  private clearFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private post(message: unknown): void {
    void this.panel?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.js'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${styleUri}" />
<title>代码上下文透镜</title>
</head>
<body>
<div id="app">
  <header class="topbar">
    <div class="title-row">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 7 4.5 12 8 17" />
            <path d="m16 7 3.5 5-3.5 5" />
            <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
          </svg>
        </div>
        <div class="brand-text">
          <h1>代码上下文透镜</h1>
          <div class="subtitle" id="subtitle">正在读取项目结构…</div>
        </div>
      </div>
      <div class="actions">
        <button class="icon-button" id="btn-copy" title="复制解读" aria-label="复制解读">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="11" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2"/></svg>
        </button>
        <button class="icon-button" id="btn-open" title="打开源文件" aria-label="打开源文件">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>
        </button>
        <button class="icon-button" id="btn-retry" title="重新分析" aria-label="重新分析">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>
        </button>
        <button class="icon-button" id="btn-settings" title="配置模型" aria-label="配置模型">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4v-.2a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/></svg>
        </button>
      </div>
    </div>
    <div class="meta" id="meta">
      <span class="pill">读取上下文中…</span>
    </div>
    <section class="locator" id="locator" aria-label="项目定位">
      <div class="locator-loading"><span></span><span></span><span></span></div>
    </section>
    <div class="tabs" role="tablist">
      <button class="tab active" id="quick-tab" role="tab" aria-selected="true">结构速览</button>
      <button class="tab" id="deep-tab" role="tab" aria-selected="false" disabled>
        AI 深度解读 <span class="badge" id="deep-badge">准备中</span>
      </button>
    </div>
  </header>

  <main>
    <section class="view active" id="view-quick" role="tabpanel">
      <div class="markdown" id="quick-body">
        <div class="skeleton"><span></span><span></span><span></span><span></span></div>
      </div>
    </section>
    <section class="view" id="view-deep" role="tabpanel">
      <div class="status-bar" id="deep-status-bar">
        <span class="spinner"></span><span id="deep-status-text">正在读取项目上下文…</span>
      </div>
      <div class="callout error hidden" id="deep-error"></div>
      <div class="markdown" id="deep-body"></div>
    </section>

    <details class="context-box" id="context-box">
      <summary>本次提供给模型的项目上下文 <span id="context-chars"></span></summary>
      <div id="context-body"></div>
    </details>
  </main>

  <footer>
    <span class="privacy">只发送选中代码与相关文件摘要；API Key 保存在 VS Code SecretStorage。</span>
    <button class="text-button" id="btn-pause">暂停自动弹窗</button>
  </footer>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function renderMeta(result: AnalysisResult): string {
  const context = result.context;
  const pills: string[] = [];
  for (const stack of context.project.stack.slice(0, 4)) {
    pills.push(`<span class="pill accent">${escapeHtml(stack)}</span>`);
  }
  pills.push(`<span class="pill">${escapeHtml(context.file.layer)} / ${escapeHtml(context.file.role)}</span>`);
  pills.push(
    `<span class="pill ${result.source === 'ai' ? 'source-ai' : 'source-local'}">${
      result.source === 'ai' ? escapeHtml(result.model ?? 'AI 深度解读') : '本地结构分析'
    }</span>`,
  );
  pills.push(`<span class="pill">${context.request.endLine - context.request.startLine + 1} 行</span>`);
  pills.push(`<span class="pill">${context.contextChars.toLocaleString()} 字符上下文</span>`);
  return pills.join('');
}

function renderContext(result: AnalysisResult): string {
  const context = result.context;
  const blocks: string[] = [];

  blocks.push(
    ctxBlock(
      '项目',
      [
        `${escapeHtml(context.project.name)} · ${escapeHtml(context.project.stack.join(' + ') || '未识别技术栈')}`,
        `顶层：${context.project.topLevel.slice(0, 18).map(escapeHtml).join(' · ')}`,
        context.project.manifests.length
          ? `清单：${context.project.manifests.map(escapeHtml).join(' · ')}`
          : '',
      ].filter(Boolean),
    ),
  );

  const outline = context.file.outline.slice(0, 8).map((line) => `<li><code>${escapeHtml(line)}</code></li>`);
  if (outline.length > 0) {
    blocks.push(ctxBlock('文件符号大纲', outline, true));
  }

  const imports = context.file.imports.slice(0, 10).map((item) => {
    const target = item.resolvedPath
      ? `<code>${escapeHtml(item.resolvedPath)}</code>`
      : item.external
        ? `<span>${escapeHtml(item.packageName ?? item.specifier)}（外部包）</span>`
        : '';
    return `<li><code>${escapeHtml(item.specifier)}</code>${target ? ` → ${target}` : ''}</li>`;
  });
  if (imports.length > 0) {
    blocks.push(ctxBlock('导入关系', imports, true));
  }

  if (context.related.length > 0) {
    const related = context.related
      .map(
        (item) =>
          `<button class="file-link" data-open-file="${escapeAttribute(item.absolutePath)}" data-line="${item.line ?? 1}"><code>${escapeHtml(item.relativePath)}</code><span class="reason">${escapeHtml(item.reason)}</span></button>`,
      )
      .join('');
    blocks.push(`<div class="ctx-block"><h3>关联文件</h3>${related}</div>`);
  }

  blocks.push(
    ctxBlock('说明', [
      `静态信号：${escapeHtml(context.detected.patterns.join('、') || '未识别设计模式')}`,
      `语言服务引用：${context.hasLanguageServerRefs ? '已找到' : '未找到或语言服务未就绪'}`,
      '已自动隐藏常见 Token / 密码模式后发送；仍建议不要在选区中保留真实凭据。',
    ]),
  );

  return `<div class="ctx-grid">${blocks.filter(Boolean).join('')}</div>`;
}

function ctxBlock(title: string, items: string[], asList = false): string {
  if (items.length === 0) {
    return '';
  }
  const body = asList
    ? `<ul>${items.join('')}</ul>`
    : items.map((item) => `<div>${item}</div>`).join('');
  return `<div class="ctx-block"><h3>${escapeHtml(title)}</h3>${body}</div>`;
}

async function openFileAt(filePath: string, line: number): Promise<void> {
  if (!filePath) {
    return;
  }
  try {
    const uri = vscode.Uri.file(filePath);
    const document = await vscode.workspace.openTextDocument(uri);
    const requestedLine = Number.isFinite(line) ? Math.round(line) : 1;
    const safeLine = Math.max(0, Math.min(document.lineCount - 1, requestedLine - 1));
    const position = new vscode.Position(safeLine, 0);
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

function getNonce(): string {
  return randomBytes(16).toString('base64url');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
