import * as http from 'node:http';
import * as https from 'node:https';
import type { ChatMessage } from '../analysis/prompt';

export interface StreamChatOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  signal: AbortSignal;
  onToken?: (token: string) => void;
}

export class AbortedError extends Error {
  public override name = 'AbortError';
}

export class ApiError extends Error {
  public readonly status: number | undefined;

  public constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function streamChatCompletion(options: StreamChatOptions): Promise<string> {
  if (options.signal.aborted) {
    throw new AbortedError('已取消');
  }

  const endpoint = normalizeEndpoint(options.baseUrl);
  const url = new URL(endpoint);
  const transport = url.protocol === 'http:' ? http : https;
  const payload = JSON.stringify({
    model: options.model,
    messages: options.messages,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    stream: true,
  });

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let fullText = '';
    let buffer = '';
    let sawEventStream = false;

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else if (!fullText.trim()) {
        reject(new ApiError('模型返回了空内容。请检查模型名、接口地址或提供商配额。'));
      } else {
        resolve(fullText.trim());
      }
    };

    const request = transport.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': 'code-context-lens/0.1.0',
          ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const contentType = String(response.headers['content-type'] ?? '');

        if (status < 200 || status >= 300) {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            if (body.length < 4000) {
              body += chunk;
            }
          });
          response.on('end', () => finish(errorForStatus(status, body)));
          response.on('error', (error) => finish(toApiError(error)));
          return;
        }

        response.setEncoding('utf8');
        sawEventStream = contentType.includes('text/event-stream');

        response.on('data', (chunk: string) => {
          if (options.signal.aborted) {
            request.destroy();
            finish(new AbortedError('已取消'));
            return;
          }

          if (!sawEventStream) {
            buffer += chunk;
            return;
          }

          buffer += chunk;
          let newlineIndex = buffer.indexOf('\n');
          while (newlineIndex >= 0) {
            const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
            buffer = buffer.slice(newlineIndex + 1);
            try {
              processLine(line, options.onToken, (token) => {
                fullText += token;
              });
            } catch (error) {
              request.destroy();
              finish(error instanceof Error ? error : new ApiError(String(error)));
              return;
            }
            if (line.trim() === 'data: [DONE]') {
              finish();
              return;
            }
            newlineIndex = buffer.indexOf('\n');
          }
        });

        response.on('end', () => {
          try {
            if (!sawEventStream) {
              const text = parseNonStreamingResponse(buffer);
              if (text) {
                fullText += text;
                options.onToken?.(text);
              }
            } else if (buffer.trim()) {
              processLine(buffer, options.onToken, (token) => {
                fullText += token;
              });
            }
            finish();
          } catch (error) {
            finish(error instanceof Error ? error : new ApiError(String(error)));
          }
        });

        response.on('error', (error) => finish(toApiError(error)));
      },
    );

    const onAbort = (): void => {
      request.destroy();
      finish(new AbortedError('已取消'));
    };
    options.signal.addEventListener('abort', onAbort, { once: true });

    request.setTimeout(options.timeoutMs, () => {
      request.destroy();
      finish(
        new ApiError(
          `请求超时（${Math.round(options.timeoutMs / 1000)} 秒）。可以尝试换更快的模型，或在设置中增大 requestTimeoutMs。`,
        ),
      );
    });

    request.on('error', (error) => {
      if (options.signal.aborted) {
        finish(new AbortedError('已取消'));
      } else {
        finish(toApiError(error));
      }
    });

    request.write(payload);
    request.end();

    function cleanup(): void {
      options.signal.removeEventListener('abort', onAbort);
    }
  });
}

function processLine(
  line: string,
  onToken: ((token: string) => void) | undefined,
  collect: (token: string) => void,
): void {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) {
    return;
  }
  const data = trimmed.slice(5).trim();
  if (!data || data === '[DONE]') {
    return;
  }
  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{
        delta?: { content?: string | null; reasoning_content?: string | null };
        message?: { content?: string | null };
        text?: string;
      }>;
      error?: { message?: string };
    };
    if (parsed.error?.message) {
      throw new ApiError(parsed.error.message);
    }
    const choice = parsed.choices?.[0];
    const token = choice?.delta?.content ?? choice?.message?.content ?? choice?.text ?? '';
    if (token) {
      onToken?.(token);
      collect(token);
    }
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    // A malformed SSE frame should not discard the whole answer.
  }
}

function parseNonStreamingResponse(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      choices?: Array<{ message?: { content?: string }; text?: string }>;
      error?: { message?: string };
    };
    if (parsed.error?.message) {
      throw new ApiError(parsed.error.message);
    }
    return parsed.choices?.[0]?.message?.content ?? parsed.choices?.[0]?.text ?? '';
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    return '';
  }
}

function normalizeEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new ApiError('接口地址为空。请运行“代码透镜：配置模型 / API Key”设置接口地址。');
  }
  if (/\/chat\/completions$/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

function errorForStatus(status: number, body: string): ApiError {
  const detail = extractErrorMessage(body);
  const suffix = detail ? `：${detail}` : '';
  switch (status) {
    case 400:
      return new ApiError(`请求格式被模型服务拒绝（400）${suffix}`, status);
    case 401:
    case 403:
      return new ApiError(`API Key 无效或没有权限（${status}）。请重新配置 Key${suffix}`, status);
    case 404:
      return new ApiError(`接口地址不存在（404）。请检查 Base URL 是否需要包含 /v1${suffix}`, status);
    case 429:
      return new ApiError(`请求过于频繁或额度不足（429）${suffix}`, status);
    default:
      if (status >= 500) {
        return new ApiError(`模型服务暂时不可用（${status}）${suffix}`, status);
      }
      return new ApiError(`模型请求失败（${status}）${suffix}`, status);
  }
}

function extractErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    const message = parsed.error?.message ?? parsed.message;
    if (message) {
      return message.slice(0, 300);
    }
  } catch {
    // Fall back to a plain-text body.
  }
  const cleaned = body.replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 300);
}

function toApiError(error: unknown): ApiError | AbortedError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof AbortedError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return new ApiError(`无法解析模型服务地址。请检查 Base URL 或网络。${message}`);
  }
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message)) {
    return new ApiError(`无法连接模型服务。请确认服务已启动、地址和代理设置正确。${message}`);
  }
  return new ApiError(`模型请求失败：${message}`);
}
