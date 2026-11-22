'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildHoverMarkdown, commandUri } = require('../out/ui/hoverMarkdown.js');

function createResult() {
  return {
    markdown: '',
    source: 'local',
    model: 'local-structure',
    requestKey: 'key',
    generatedAt: Date.now(),
    context: {
      request: {
        uri: 'file:///d:/repo/src/a.ts',
        documentVersion: 1,
        fileName: 'a.ts',
        relativePath: 'src/a.ts',
        absolutePath: 'D:/repo/src/a.ts',
        languageId: 'typescript',
        startLine: 3,
        endLine: 9,
        startCharacter: 0,
        endCharacter: 1,
        selectedText: 'code',
      },
      project: {
        name: 'demo',
        rootPath: 'D:/repo',
        stack: ['React', 'TypeScript'],
        manifests: ['package.json'],
        topLevel: ['src/'],
        structure: {
          root: {
            name: 'demo',
            path: '',
            kind: 'directory',
            children: [
              {
                name: 'src',
                path: 'src',
                kind: 'directory',
                children: [
                  {
                    name: 'a.ts',
                    path: 'src/a.ts',
                    kind: 'file',
                    children: [],
                  },
                ],
              },
            ],
          },
          selectedPath: 'src/a.ts',
          breadcrumb: ['demo', 'src', 'a.ts'],
          totalDirectories: 1,
          totalFiles: 1,
          truncated: false,
        },
        fingerprint: 'x',
      },
      file: {
        relativePath: 'src/a.ts',
        languageId: 'typescript',
        outline: [],
        imports: [],
        exports: [],
        layer: '业务层',
        role: '业务服务',
      },
      surroundingCode: '',
      related: [
        {
          relativePath: 'src/b.ts',
          absolutePath: 'D:/repo/src/b.ts',
          reason: '当前文件直接导入',
          line: 2,
        },
      ],
      detected: {
        declarations: [],
        calls: [],
        patterns: [],
        routes: [],
        hasAsync: false,
        hasTryCatch: false,
        isTest: false,
        lineCount: 1,
        branchCount: 1,
        maxIndentDepth: 0,
        importCount: 0,
      },
      contextText: '',
      contextChars: 0,
      generatedAt: Date.now(),
      hasLanguageServerRefs: false,
    },
    sections: {
      summary: '**总结**：这段代码负责编排。',
      position: '- 位于业务层',
      design: '- 通过依赖倒置隔离数据访问',
      flow: '入口 → `load()`',
      relations: '- `src/b.ts`',
      risks: '- 注意错误处理',
    },
  };
}

test('hover markdown includes project-aware sections and trusted commands', () => {
  const result = createResult();
  const markdown = buildHoverMarkdown(result, {
    deepPending: false,
    provider: {
      kind: 'local',
      label: '本地结构分析',
      model: 'local-structure',
      baseUrl: '',
      available: false,
      requiresKey: false,
    },
  });

  assert.match(markdown, /代码透镜/);
  assert.match(markdown, /src\/a\.ts:3-9/);
  assert.match(markdown, /项目/);
  assert.match(markdown, /架构层/);
  assert.match(markdown, /关键点/);
  assert.match(markdown, /└─ src/);
  assert.match(markdown, /◀ 选中/);
  assert.match(markdown, /command:codeContextLens\.openFullExplanation/);
  assert.match(markdown, /配置模型/);
  assert.ok(markdown.length < 1800, 'hover 内容应保持简短');
});

test('hover markdown tolerates model names with markdown characters', () => {
  const result = createResult();
  result.source = 'ai';
  result.model = 'evil`](command:bad)';
  const markdown = buildHoverMarkdown(result, {
    deepPending: false,
    provider: {
      kind: 'deepseek',
      label: 'DeepSeek',
      model: result.model,
      baseUrl: '',
      available: true,
      requiresKey: true,
    },
  });
  assert.doesNotMatch(markdown, /command:bad/);
  assert.match(markdown, /evilbad/);
});

test('command URIs encode parentheses so Windows paths stay clickable', () => {
  const uri = commandUri('codeContextLens.openRelatedFile', {
    path: 'C:\\Program Files (x86)\\demo\\a.ts',
    line: 1,
  });
  assert.match(uri, /%28/);
  assert.match(uri, /%29/);
  assert.doesNotMatch(uri, /\(x86\)/);
  assert.equal(
    JSON.parse(decodeURIComponent(uri.slice(uri.indexOf('?') + 1)))[0].line,
    1,
  );
});
