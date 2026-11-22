import type { AnalysisResult, ProviderInfo } from '../types';
import { truncate } from '../types';
import { compactTreeLines, getLayerRail } from '../structure/tree';
import { sanitizeForHover } from './markdown';

export interface HoverContext {
  deepPending: boolean;
  provider: ProviderInfo;
}

/**
 * The hover is intentionally a glance, not a report:
 * one-sentence takeaway, a tiny project tree, the architecture rail, and three key points.
 */
export function buildHoverMarkdown(result: AnalysisResult, context: HoverContext): string {
  const request = result.context.request;
  const filePath = request.relativePath.replace(/`/g, '\\`');
  const modelLabel = (result.model || 'AI')
    .replace(/command:/gi, '')
    .replace(/[`\[\]()<>]/g, '');
  const sourceLabel = result.source === 'ai' ? modelLabel : '本地速览';
  const stack = result.context.project.stack.slice(0, 3).join(' + ') || '未识别技术栈';
  const lines: string[] = [];

  lines.push(`**代码透镜** · \`${filePath}:${request.startLine}-${request.endLine}\``);
  lines.push(`${stack} · **${result.context.file.layer}** · ${sourceLabel}`);
  lines.push('');

  const summary = firstPoint(sanitizeForHover(result.sections.summary), 150);
  if (summary) {
    lines.push(`> ${summary}`);
    lines.push('');
  }

  const tree = compactTreeLines(result.context.project.structure, {
    maxLines: 10,
    maxSiblings: 1,
  });
  if (tree.length > 0) {
    lines.push('```text');
    lines.push(...tree);
    lines.push('```');
    lines.push('');
  }

  const rails = getLayerRail(result.context.file.layer);
  if (rails.some((item) => item.active)) {
    lines.push(
      `架构层：${rails
        .map((item) => (item.active ? `**${item.label}**` : item.label))
        .join(' → ')}`,
    );
    lines.push('');
  }

  const structurePoint = dependencyPoint(result);
  const designPoint = firstPoint(sanitizeForHover(result.sections.design), 110);
  const riskPoint = firstPoint(sanitizeForHover(result.sections.risks), 110);

  lines.push('**关键点**');
  lines.push(`- **结构** ${structurePoint}`);
  if (designPoint) {
    lines.push(`- **设计** ${designPoint}`);
  }
  if (riskPoint) {
    lines.push(`- **风险** ${riskPoint}`);
  }
  lines.push('');

  if (context.deepPending) {
    lines.push('_AI 正在后台补充设计解读…_');
    lines.push('');
  }

  const fullCommand = commandUri('codeContextLens.openFullExplanation', {
    uri: request.uri,
    documentVersion: request.documentVersion,
    startLine: request.startLine,
    endLine: request.endLine,
    startCharacter: request.startCharacter,
    endCharacter: request.endCharacter,
  });
  const copyCommand = commandUri('codeContextLens.copyExplanation', {
    uri: request.uri,
    documentVersion: request.documentVersion,
    startLine: request.startLine,
    endLine: request.endLine,
    startCharacter: request.startCharacter,
    endCharacter: request.endCharacter,
  });
  const revealCommand = commandUri('codeContextLens.openRelatedFile', {
    path: request.absolutePath,
    line: request.startLine,
  });

  const actions = [
    `[完整解读](${fullCommand})`,
    `[定位](${revealCommand})`,
    `[复制](${copyCommand})`,
  ];
  if (context.provider.kind === 'local' || !context.provider.available) {
    actions.push(`[配置模型](${commandUri('codeContextLens.configure', {})})`);
  }
  lines.push(actions.join(' · '));

  return lines.join('\n');
}

function dependencyPoint(result: AnalysisResult): string {
  const context = result.context;
  const internal = context.file.imports.filter((item) => !item.external && item.resolvedPath);
  const external = context.file.imports.filter((item) => item.external);
  const references = context.related.filter((item) => item.reason.includes('引用')).length;
  const parts: string[] = [];

  if (internal.length > 0) {
    parts.push(`依赖 \`${internal[0]?.resolvedPath}\``);
  } else if (external.length > 0) {
    parts.push(`依赖外部包 \`${external[0]?.packageName ?? external[0]?.specifier}\``);
  } else {
    parts.push('无项目内直接依赖');
  }

  if (references > 0) {
    parts.push(`${references} 个模块引用它`);
  } else {
    const symbol = context.detected.declarations[0] ?? context.file.enclosingSymbol;
    if (symbol) {
      parts.push(`符号 \`${symbol}\``);
    }
  }

  return parts.join('；');
}

function firstPoint(markdown: string, maxChars: number): string {
  const lines = markdown
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replace(/^[-*+]\s+/, '')
        .replace(/^>\s*/, '')
        .replace(/^\*\*[^*]+\*\*\s*/, '')
        .replace(/^[：:;；\-–—\s]+/, '')
        .trim(),
    )
    .filter(Boolean);

  if (lines.length === 0) {
    return '';
  }
  return truncate(lines[0] ?? '', maxChars).replace(/[。；;]\s*$/, '');
}

export function commandUri(command: string, args: unknown): string {
  const encoded = encodeURIComponent(JSON.stringify([args])).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `command:${command}?${encoded}`;
}
