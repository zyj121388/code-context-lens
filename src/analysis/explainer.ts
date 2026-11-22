import * as vscode from 'vscode';
import { readConfig, resolveProvider, type LensConfig, type ProviderResolution } from '../config';
import { logError, logInfo } from '../logger';
import { AbortedError, streamChatCompletion } from '../llm/openAiCompatible';
import type {
  AnalysisResult,
  ContextBundle,
  DeepStatus,
  ProviderInfo,
  SelectionRequest,
} from '../types';
import { requestKey, toAnchor } from '../types';
import { buildMessages } from './prompt';
import { analyzeLocal } from './localAnalyzer';
import { extractSections } from '../ui/markdown';
import { ContextCollector, type ContextOptions } from '../context/contextCollector';

export interface DeepHandlers {
  onStatus?: (status: DeepStatus) => void;
  onToken?: (fullText: string, token: string) => void;
  onDone?: (result: AnalysisResult) => void;
  onError?: (error: Error) => void;
}

interface DeepJob {
  key: string;
  controller: AbortController;
  text: string;
  handlers: Set<DeepHandlers>;
  promise: Promise<AnalysisResult>;
}

export class ProviderUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

export class ExplainerService implements vscode.Disposable {
  private readonly collector = new ContextCollector();
  private readonly quickCache = new Map<string, AnalysisResult>();
  private readonly aiCache = new Map<string, AnalysisResult>();
  private readonly jobs = new Map<string, DeepJob>();
  private readonly deepReadyEmitter = new vscode.EventEmitter<AnalysisResult>();
  private readonly statusEmitter = new vscode.EventEmitter<DeepStatus>();

  public readonly onDidDeepReady = this.deepReadyEmitter.event;
  public readonly onDidDeepStatus = this.statusEmitter.event;

  public constructor(public readonly secrets: vscode.SecretStorage) {}

  public async prepare(request: SelectionRequest, token?: vscode.CancellationToken): Promise<AnalysisResult> {
    const key = requestKey(request);
    const cached = this.aiCache.get(key) ?? this.quickCache.get(key);
    if (cached) {
      return cached;
    }

    const config = readConfig();
    const options: ContextOptions = {
      maxContextChars: config.maxContextChars,
      surroundingLines: config.surroundingLines,
      includeReadme: config.includeReadme,
      includeRelatedFiles: config.includeRelatedFiles,
      maxRelatedFiles: config.maxRelatedFiles,
    };

    const context = await this.withCancellation(this.collector.collect(request, options), token);
    if (token?.isCancellationRequested) {
      throw new AbortedError('已取消');
    }

    const result = analyzeLocal(context);
    result.requestKey = key;
    this.remember(this.quickCache, key, result);
    logInfo(
      `Prepared local context for ${request.relativePath}:${request.startLine}-${request.endLine} (${context.contextChars} chars, ${context.related.length} related files)`,
    );
    return result;
  }

  public getCached(request: SelectionRequest): AnalysisResult | undefined {
    const key = requestKey(request);
    return this.aiCache.get(key) ?? this.quickCache.get(key);
  }

  public async getProviderInfo(): Promise<ProviderInfo> {
    const config = readConfig();
    const resolution = await resolveProvider(config, this.secrets);
    return resolution.info;
  }

  public async isDeepAvailable(): Promise<boolean> {
    const info = await this.getProviderInfo();
    return info.kind !== 'local' && info.available;
  }

  public async startBackgroundDeep(request: SelectionRequest, config: LensConfig): Promise<boolean> {
    if (!config.autoDeepAnalysis) {
      return false;
    }
    try {
      const info = await this.getProviderInfo();
      if (info.kind === 'local' || !info.available) {
        return false;
      }
      void this.generateDeep(request, config, {
        onStatus: (status) => this.statusEmitter.fire(status),
      }).catch((error: unknown) => {
        if (!(error instanceof Error) || error.name !== 'AbortError') {
          logError('Background deep analysis failed', error);
        }
      });
      return true;
    } catch (error) {
      logError('Unable to start background deep analysis', error);
      return false;
    }
  }

  public async generateDeep(
    request: SelectionRequest,
    config: LensConfig,
    handlers: DeepHandlers = {},
  ): Promise<AnalysisResult> {
    const key = requestKey(request);
    const cached = this.aiCache.get(key);
    if (cached) {
      handlers.onStatus?.({
        state: 'done',
        message: '使用已缓存的深度解读',
        provider: cached.model,
        model: cached.model,
      });
      handlers.onDone?.(cached);
      return cached;
    }

    const existing = this.jobs.get(key);
    if (existing) {
      existing.handlers.add(handlers);
      if (existing.text) {
        handlers.onToken?.(existing.text, '');
      }
      handlers.onStatus?.({
        state: 'streaming',
        message: '正在生成深度解读…',
      });
      return existing.promise;
    }

    const resolution = await resolveProvider(config, this.secrets);
    if (resolution.info.kind === 'local' || !resolution.info.available) {
      throw new ProviderUnavailableError(
        resolution.info.reason ?? '深度解读不可用，请先配置模型 API Key。',
      );
    }

    const local = this.quickCache.get(key) ?? (await this.prepare(request));
    const controller = new AbortController();
    const job: DeepJob = {
      key,
      controller,
      text: '',
      handlers: new Set<DeepHandlers>([handlers]),
      promise: Promise.resolve(local),
    };
    this.jobs.set(key, job);

    const status: DeepStatus = {
      state: 'streaming',
      message: `${resolution.info.label} · ${resolution.info.model} 正在结合项目上下文生成…`,
      provider: resolution.info.label,
      model: resolution.info.model,
    };
    handlers.onStatus?.(status);
    this.statusEmitter.fire(status);

    job.promise = this.runDeep(job, local, resolution, config)
      .finally(() => {
        if (this.jobs.get(key) === job) {
          this.jobs.delete(key);
        }
      });

    return job.promise;
  }

  public cancel(request: SelectionRequest): void {
    const key = requestKey(request);
    const job = this.jobs.get(key);
    if (job) {
      this.jobs.delete(key);
      job.controller.abort();
    }
  }

  public cancelAll(): void {
    const jobs = [...this.jobs.values()];
    this.jobs.clear();
    for (const job of jobs) {
      job.controller.abort();
    }
  }

  public invalidate(request?: SelectionRequest): void {
    if (!request) {
      this.cancelAll();
      this.quickCache.clear();
      this.aiCache.clear();
      return;
    }
    const key = requestKey(request);
    this.quickCache.delete(key);
    this.aiCache.delete(key);
    const job = this.jobs.get(key);
    if (job) {
      this.jobs.delete(key);
      job.controller.abort();
    }
  }

  public dispose(): void {
    this.cancelAll();
    this.deepReadyEmitter.dispose();
    this.statusEmitter.dispose();
  }

  public anchorFor(request: SelectionRequest): ReturnType<typeof toAnchor> {
    return toAnchor(request);
  }

  private async runDeep(
    job: DeepJob,
    local: AnalysisResult,
    resolution: ProviderResolution,
    config: LensConfig,
  ): Promise<AnalysisResult> {
    const context: ContextBundle = local.context;
    const messages = buildMessages(context);
    const model = resolution.info.model;
    let lastStatusAt = 0;

    try {
      const markdown = await streamChatCompletion({
        baseUrl: resolution.info.baseUrl,
        model,
        apiKey: resolution.apiKey,
        messages,
        temperature: config.temperature,
        maxTokens: config.maxOutputTokens,
        timeoutMs: config.requestTimeoutMs,
        signal: job.controller.signal,
        onToken: (token) => {
          if (!token) {
            return;
          }
          job.text += token;
          for (const handlers of job.handlers) {
            handlers.onToken?.(job.text, token);
          }
          const now = Date.now();
          if (now - lastStatusAt > 250) {
            lastStatusAt = now;
            this.statusEmitter.fire({
              state: 'streaming',
              message: `正在生成… ${job.text.length} 字符`,
              provider: resolution.info.label,
              model,
            });
          }
        },
      });

      const sections = extractSections(markdown);
      const filled = fillMissingSections(sections, local.sections);
      const result: AnalysisResult = {
        markdown,
        sections: filled,
        source: 'ai',
        model,
        requestKey: job.key,
        context,
        generatedAt: Date.now(),
      };
      this.remember(this.aiCache, job.key, result);
      this.remember(this.quickCache, job.key, result);

      const done: DeepStatus = {
        state: 'done',
        message: '深度解读已生成',
        provider: resolution.info.label,
        model,
      };
      for (const handlers of job.handlers) {
        handlers.onDone?.(result);
        handlers.onStatus?.(done);
      }
      this.deepReadyEmitter.fire(result);
      this.statusEmitter.fire(done);
      return result;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      for (const handlers of job.handlers) {
        handlers.onError?.(normalized);
        handlers.onStatus?.({
          state: normalized instanceof AbortedError ? 'idle' : 'error',
          message:
            normalized instanceof AbortedError
              ? '已取消'
              : `深度解读失败：${normalized.message}`,
          provider: resolution.info.label,
          model,
        });
      }
      this.statusEmitter.fire({
        state: normalized instanceof AbortedError ? 'idle' : 'error',
        message:
          normalized instanceof AbortedError ? '已取消' : `深度解读失败：${normalized.message}`,
      });
      if (!(normalized instanceof AbortedError)) {
        logError('Deep analysis request failed', normalized);
      }
      throw normalized;
    }
  }

  private remember(cache: Map<string, AnalysisResult>, key: string, result: AnalysisResult): void {
    cache.set(key, result);
    while (cache.size > 40) {
      const oldest = cache.keys().next();
      if (oldest.done) {
        break;
      }
      cache.delete(oldest.value);
    }
  }

  private async withCancellation<T>(promise: Promise<T>, token?: vscode.CancellationToken): Promise<T> {
    if (!token) {
      return promise;
    }
    if (token.isCancellationRequested) {
      throw new AbortedError('已取消');
    }
    return await new Promise<T>((resolve, reject) => {
      let disposable: vscode.Disposable | undefined;
      disposable = token.onCancellationRequested(() => {
        disposable?.dispose();
        reject(new AbortedError('已取消'));
      });
      promise.then(
        (value) => {
          disposable?.dispose();
          resolve(value);
        },
        (error: unknown) => {
          disposable?.dispose();
          reject(error);
        },
      );
    });
  }
}

function fillMissingSections(
  sections: ReturnType<typeof extractSections>,
  fallback: ReturnType<typeof extractSections>,
): ReturnType<typeof extractSections> {
  return {
    summary: sections.summary || fallback.summary,
    position: sections.position || fallback.position,
    design: sections.design || fallback.design,
    flow: sections.flow || fallback.flow,
    relations: sections.relations || fallback.relations,
    risks: sections.risks || fallback.risks,
  };
}
