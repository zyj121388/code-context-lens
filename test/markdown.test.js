'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  renderMarkdown,
  extractSections,
  sanitizeForHover,
  condenseSection,
  escapeHtml,
} = require('../out/ui/markdown.js');

test('extractSections maps the fixed model headings', () => {
  const markdown = [
    '## 一句话总结',
    '总结内容',
    '## 它在系统中的位置',
    '- 位置内容',
    '## 设计思路',
    '设计内容',
    '## 调用链与数据流',
    '流转内容',
    '## 关联文件',
    '- `src/a.ts` — 原因',
    '## 风险与改进',
    '风险内容',
  ].join('\n');

  const sections = extractSections(markdown);
  assert.equal(sections.summary, '总结内容');
  assert.match(sections.position, /位置内容/);
  assert.equal(sections.design, '设计内容');
  assert.equal(sections.flow, '流转内容');
  assert.match(sections.relations, /src\/a\.ts/);
  assert.equal(sections.risks, '风险内容');
});

test('sanitizeForHover removes links, HTML and command URIs', () => {
  const input =
    '看[这里](command:evil.run?%5B%5D) <img src=x onerror=alert(1)> [文档](https://example.com) `a < b`';
  const output = sanitizeForHover(input);
  assert.doesNotMatch(output, /command:/i);
  assert.doesNotMatch(output, /<img/i);
  assert.doesNotMatch(output, /\]\(https:/);
  assert.match(output, /这里/);
  assert.match(output, /文档/);
  assert.match(output, /`a < b`/);
});

test('renderMarkdown escapes HTML and supports code, lists and links', () => {
  const html = renderMarkdown(
    [
      '## 标题',
      '**加粗** 与 `code <x>`',
      '',
      '- 第一项',
      '- 第二项',
      '',
      '```ts',
      'const x = "<script>";',
      '```',
      '',
      '[官网](https://example.com)',
    ].join('\n'),
  );

  assert.match(html, /<h2>标题<\/h2>/);
  assert.match(html, /<strong>加粗<\/strong>/);
  assert.match(html, /<code>code &lt;x&gt;<\/code>/);
  assert.match(html, /<ul>/);
  assert.match(html, /const x = &quot;&lt;script&gt;&quot;;/);
  assert.match(html, /data-external="1"/);
  assert.doesNotMatch(html, /<script>/);
});

test('condenseSection keeps only the requested number of lines', () => {
  const value = condenseSection('- one\n- two\n- three\n- four', { maxLines: 2 });
  assert.equal(value, '- one\n- two');
});

test('escapeHtml covers attribute-sensitive characters', () => {
  assert.equal(escapeHtml('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
});
