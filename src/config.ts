import * as vscode from 'vscode';
import type {
  ProviderInfo,
  ProviderKind,
  ResolvedProviderKind,
} from './types';

export interface LensConfig {
  enabled: boolean;
  autoPopup: boolean;
  popupStyle: 'hover' | 'panel';
  delayMs: number;
  minSelectionChars: number;
  maxContextChars: number;
  surroundingLines: number;
  provider: ProviderKind;
  model: string;
  baseUrl: string;
  temperature: number;
  maxOutputTokens: number;
  autoDeepAnalysis: boolean;
  refreshHoverWhenReady: boolean;
  showStatusBar: boolean;
  includeReadme: boolean;
  includeRelatedFiles: boolean;
  maxRelatedFiles: number;
  requestTimeoutMs: number;
}

export interface ProviderResolution {
  info: ProviderInfo;
  apiKey?: string;
}

const DEFAULTS: Record<
  ResolvedProviderKind,
  { baseUrl: string; model: string; label: string; requiresKey: boolean }
> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    label: 'DeepSeek',
    requiresKey: true,
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    label: 'OpenAI',
    requiresKey: true,
  },
  ollama: {
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5-coder:7b',
    label: 'Ollama',
    requiresKey: false,
  },
};

const SECRET_PREFIX = 'codeContextLens.apiKey.';

export function readConfig(): LensConfig {
  const config = vscode.workspace.getConfiguration('codeContextLens');
  const provider = config.get<ProviderKind>('provider', 'auto');
  const popupStyle = config.get<'hover' | 'panel'>('popupStyle', 'hover');

  return {
    enabled: config.get<boolean>('enabled', true),
    autoPopup: config.get<boolean>('autoPopup', true),
    popupStyle: popupStyle === 'panel' ? 'panel' : 'hover',
    delayMs: clamp(config.get<number>('delayMs', 650), 200, 5000),
    minSelectionChars: clamp(config.get<number>('minSelectionChars', 8), 1, 2000),
    maxContextChars: clamp(config.get<number>('maxContextChars', 28000), 4000, 80000),
    surroundingLines: clamp(config.get<number>('surroundingLines', 60), 0, 300),
    provider: isProviderKind(provider) ? provider : 'auto',
    model: config.get<string>('model', '').trim(),
    baseUrl: config.get<string>('baseUrl', '').trim(),
    temperature: clamp(config.get<number>('temperature', 0.2), 0, 1.5),
    maxOutputTokens: clamp(config.get<number>('maxOutputTokens', 1200), 300, 8000),
    autoDeepAnalysis: config.get<boolean>('autoDeepAnalysis', true),
    refreshHoverWhenReady: config.get<boolean>('refreshHoverWhenReady', true),
    showStatusBar: config.get<boolean>('showStatusBar', true),
    includeReadme: config.get<boolean>('includeReadme', true),
    includeRelatedFiles: config.get<boolean>('includeRelatedFiles', true),
    maxRelatedFiles: clamp(config.get<number>('maxRelatedFiles', 6), 0, 20),
    requestTimeoutMs: clamp(config.get<number>('requestTimeoutMs', 120000), 5000, 600000),
  };
}

export function secretKey(kind: ResolvedProviderKind): string {
  return `${SECRET_PREFIX}${kind}`;
}

export async function resolveProvider(
  config: LensConfig,
  secrets: vscode.SecretStorage,
): Promise<ProviderResolution> {
  const selected = config.provider;

  if (selected === 'local') {
    return {
      info: localProviderInfo('已选择本地结构分析模式', false),
    };
  }

  if (selected === 'auto') {
    const deepseekKey = await secrets.get(secretKey('deepseek'));
    if (deepseekKey) {
      return buildResolution('deepseek', config, deepseekKey);
    }
    const openaiKey = await secrets.get(secretKey('openai'));
    if (openaiKey) {
      return buildResolution('openai', config, openaiKey);
    }
    return {
      info: localProviderInfo(
        '未配置 API Key，当前使用本地结构分析。配置 Key 后自动启用深度解读。',
        true,
      ),
    };
  }

  const key = await secrets.get(secretKey(selected));
  return buildResolution(selected, config, key);
}

export function providerDisplayName(kind: ProviderKind): string {
  switch (kind) {
    case 'deepseek':
      return 'DeepSeek';
    case 'openai':
      return 'OpenAI';
    case 'ollama':
      return 'Ollama';
    case 'local':
      return '本地结构分析';
    case 'auto':
      return '自动选择';
  }
}

/** Returns the concrete provider the user chose, useful for the Key dialog. */
export function selectedProviderForDialog(config: LensConfig): Exclude<ProviderKind, 'auto'> {
  return config.provider === 'auto' ? 'deepseek' : config.provider;
}

function buildResolution(
  kind: ResolvedProviderKind,
  config: LensConfig,
  apiKey: string | undefined,
): ProviderResolution {
  const defaults = DEFAULTS[kind];
  const baseUrl = config.baseUrl || defaults.baseUrl;
  const model = config.model || defaults.model;
  const hasKey = Boolean(apiKey);
  const available = !defaults.requiresKey || hasKey;

  return {
    apiKey,
    info: {
      kind,
      label: defaults.label,
      model,
      baseUrl,
      available,
      requiresKey: defaults.requiresKey,
      reason: available
        ? undefined
        : `未配置 ${defaults.label} API Key。运行“代码透镜：配置模型 / API Key”即可启用。`,
    },
  };
}

function localProviderInfo(reason: string, canConfigure: boolean): ProviderInfo {
  return {
    kind: 'local',
    label: '本地结构分析',
    model: 'local-structure',
    baseUrl: '',
    available: canConfigure,
    requiresKey: false,
    reason,
  };
}

function isProviderKind(value: string): value is ProviderKind {
  return (
    value === 'auto' ||
    value === 'deepseek' ||
    value === 'openai' ||
    value === 'ollama' ||
    value === 'local'
  );
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}
