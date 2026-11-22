import type { AnalysisSections } from '../types';
import { truncate } from '../types';

const SECTION_ALIASES: Array<[keyof AnalysisSections, RegExp]> = [
  ['summary', /一句话总结|摘要|总结|summary/i],
  ['position', /系统中的位置|项目中的位置|所在位置|整体位置|position|context/i],
  ['design', /设计思路|设计取舍|架构设计|设计|architecture|design/i],
  ['flow', /调用链与数据流|调用链|数据流|执行流程|flow/i],
  ['relations', /关联文件|相关文件|依赖关系|related|dependencies/i],
  ['risks', /风险与改进|风险|注意事项|改进建议|risk|improvement/i],
];

/**
 * Removes HTML, images and every markdown link target from model output.
 * The hover widget is rendered with isTrusted=true so that our own commands
 * work, therefore model-provided command/file URIs must never survive.
 */
export function sanitizeForHover(markdown: string): string {
  let text = markdown.replace(/\r\n/g, '\n');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<[^>]*>/g, '');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/\b(?:command|vscode|javascript|file|data):[^\s)]*/gi, '');
  text = text.replace(/\u0000/g, '');
  return text.trim();
}

export function extractSections(markdown: string): AnalysisSections {
  const text = markdown.replace(/\r\n/g, '\n');
  const sections: AnalysisSections = {
    summary: '',
    position: '',
    design: '',
    flow: '',
    relations: '',
    risks: '',
  };

  const buckets = new Map<keyof AnalysisSections, string[]>();
  let current: keyof AnalysisSections | undefined;
  let sawHeading = false;
  let inFence = false;

  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      if (current) {
        buckets.get(current)?.push(line);
      }
      continue;
    }
    if (inFence) {
      if (current) {
        buckets.get(current)?.push(line);
      }
      continue;
    }

    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line) ?? /^\*\*([^*]+)\*\*\s*$/.exec(line);
    if (heading) {
      sawHeading = true;
      const title = heading[1]?.trim() ?? '';
      const matched = matchSection(title);
      if (matched) {
        current = matched;
        if (!buckets.has(matched)) {
          buckets.set(matched, []);
        }
        continue;
      }
      // An unknown heading ends the previous section but is kept out of it.
      if (current) {
        current = undefined;
      }
      continue;
    }
    if (current) {
      buckets.get(current)?.push(line);
    }
  }

  if (!sawHeading) {
    sections.summary = sanitizeForHover(text);
    return sections;
  }

  for (const [key, lines] of buckets) {
    sections[key] = sanitizeForHover(lines.join('\n').replace(/^[-*_]{3,}\s*$/gm, '').trim());
  }

  if (!sections.summary) {
    const firstParagraph = sanitizeForHover(
      text
        .replace(/^#{1,6}\s+.+$/gm, '')
        .split(/\n\s*\n/)
        .map((part) => part.trim())
        .find(Boolean) ?? '',
    );
    sections.summary = firstParagraph;
  }

  return sections;
}

export function condenseSection(
  source: string,
  options: { maxChars?: number; maxLines?: number } = {},
): string {
  const maxChars = options.maxChars ?? 420;
  const maxLines = options.maxLines ?? 4;
  const lines = source
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return '';
  }

  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (kept.length >= maxLines) {
      break;
    }
    const remaining = maxChars - used;
    if (remaining <= 8) {
      break;
    }
    const value = truncate(line, Math.min(240, remaining), '…');
    kept.push(value);
    used += value.length + 1;
  }

  if (kept.length === 0) {
    return truncate(source.trim(), maxChars);
  }
  return kept.join('\n');
}

export function renderMarkdown(markdown: string): string {
  const source = markdown.replace(/\r\n/g, '\n').replace(/\u0000/g, '');
  const lines = source.split('\n');
  const html: string[] = [];

  let paragraph: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let quoteLines: string[] = [];
  let inCode = false;
  let codeLanguage = '';
  let codeLines: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      html.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };

  const closeList = (): void => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  const flushQuote = (): void => {
    if (quoteLines.length > 0) {
      html.push(`<blockquote>${renderInline(quoteLines.join(' '))}</blockquote>`);
      quoteLines = [];
    }
  };

  const flushAll = (): void => {
    flushParagraph();
    closeList();
    flushQuote();
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');

    if (inCode) {
      if (/^\s*```/.test(line) || /^\s*~~~/.test(line)) {
        const languageClass = codeLanguage ? ` class="language-${codeLanguage}"` : '';
        html.push(`<pre><code${languageClass}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        inCode = false;
        codeLanguage = '';
        codeLines = [];
      } else {
        codeLines.push(rawLine);
      }
      continue;
    }

    const fence = /^\s*(```|~~~)\s*([a-zA-Z0-9#+._-]*)\s*$/.exec(line);
    if (fence) {
      flushAll();
      inCode = true;
      codeLanguage = sanitizeLanguage(fence[2] ?? '');
      codeLines = [];
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flushAll();
      html.push('<hr />');
      continue;
    }

    const heading = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      flushAll();
      const rawLevel = heading[1]?.length ?? 2;
      const level = rawLevel <= 2 ? 2 : Math.min(4, rawLevel);
      html.push(`<h${level}>${renderInline(heading[2] ?? '')}</h${level}>`);
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      closeList();
      quoteLines.push(quote[1] ?? '');
      continue;
    }
    flushQuote();

    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (listType !== 'ul') {
        closeList();
        html.push('<ul>');
        listType = 'ul';
      }
      html.push(`<li>${renderInline(bullet[1] ?? '')}</li>`);
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (ordered) {
      flushParagraph();
      if (listType !== 'ol') {
        closeList();
        html.push('<ol>');
        listType = 'ol';
      }
      html.push(`<li>${renderInline(ordered[1] ?? '')}</li>`);
      continue;
    }

    if (listType) {
      // A plain line after a list is a new paragraph, not a list continuation.
      closeList();
    }
    paragraph.push(line.trim());
  }

  if (inCode) {
    const languageClass = codeLanguage ? ` class="language-${codeLanguage}"` : '';
    html.push(`<pre><code${languageClass}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  }
  flushAll();

  return html.join('\n');
}

export function renderInline(source: string): string {
  const codeSpans: string[] = [];
  let text = source.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const token = `\u0000C${codeSpans.length}\u0000`;
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  text = escapeHtml(text);
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label: string, url: string) =>
      `<a href="${escapeAttribute(url)}" data-external="1" rel="noreferrer noopener">${label}</a>`,
  );

  return text.replace(/\u0000C(\d+)\u0000/g, (_match, index: string) => codeSpans[Number(index)] ?? '');
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

export function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchSection(title: string): keyof AnalysisSections | undefined {
  for (const [key, pattern] of SECTION_ALIASES) {
    if (pattern.test(title)) {
      return key;
    }
  }
  return undefined;
}

function sanitizeLanguage(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9#+._-]/g, '').slice(0, 24);
}
