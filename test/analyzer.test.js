'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzeLocal } = require('../out/analysis/localAnalyzer.js');
const { buildMessages } = require('../out/analysis/prompt.js');

function createContext() {
  return {
    request: {
      uri: 'file:///d:/repo/src/services/userService.ts',
      documentVersion: 3,
      fileName: 'userService.ts',
      relativePath: 'src/services/userService.ts',
      absolutePath: 'D:/repo/src/services/userService.ts',
      languageId: 'typescript',
      startLine: 12,
      endLine: 20,
      startCharacter: 0,
      endCharacter: 2,
      selectedText: 'export async function getUser(id: string) { return repo.findById(id); }',
    },
    project: {
      name: 'demo',
      rootPath: 'D:/repo',
      stack: ['React', 'TypeScript', 'Node.js'],
      manifests: ['package.json'],
      topLevel: ['src/', 'tests/', 'package.json'],
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
                  name: 'services',
                  path: 'src/services',
                  kind: 'directory',
                  children: [
                    {
                      name: 'userService.ts',
                      path: 'src/services/userService.ts',
                      kind: 'file',
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
        selectedPath: 'src/services/userService.ts',
        breadcrumb: ['demo', 'src', 'services', 'userService.ts'],
        totalDirectories: 2,
        totalFiles: 1,
        truncated: false,
      },
      fingerprint: 'abc',
    },
    file: {
      relativePath: 'src/services/userService.ts',
      languageId: 'typescript',
      outline: ['Function getUser  (12-20)'],
      enclosingSymbol: 'getUser',
      imports: [
        {
          specifier: '../db/userRepo',
          resolvedPath: 'src/db/userRepo.ts',
          external: false,
          symbols: ['repo'],
        },
      ],
      exports: ['getUser'],
      layer: '业务层',
      role: '业务服务 / 领域逻辑',
    },
    surroundingCode: 'export async function getUser(id: string) { return repo.findById(id); }',
    related: [
      {
        relativePath: 'src/db/userRepo.ts',
        absolutePath: 'D:/repo/src/db/userRepo.ts',
        reason: '当前文件直接导入',
        excerpt: 'export const repo = { findById: async (id) => db.query(id) };',
        line: 1,
      },
    ],
    detected: {
      declarations: ['getUser'],
      calls: ['findById'],
      patterns: ['仓储 / 数据访问'],
      routes: [],
      hasAsync: true,
      hasTryCatch: false,
      isTest: false,
      lineCount: 1,
      branchCount: 1,
      maxIndentDepth: 1,
      importCount: 1,
    },
    contextText: 'ctx',
    contextChars: 3,
    generatedAt: Date.now(),
    hasLanguageServerRefs: false,
  };
}

test('local analyzer produces all six architecture sections', () => {
  const result = analyzeLocal(createContext());
  assert.equal(result.source, 'local');
  for (const heading of [
    '## 一句话总结',
    '## 它在系统中的位置',
    '## 设计思路',
    '## 调用链与数据流',
    '## 关联文件',
    '## 风险与改进',
  ]) {
    assert.ok(result.markdown.includes(heading), `missing ${heading}`);
  }
  assert.match(result.markdown, /React \+ TypeScript/);
  assert.match(result.markdown, /src\/db\/userRepo\.ts/);
  assert.match(result.markdown, /异步/);
  assert.ok(result.sections.design.length > 50);
});

test('prompt includes project context and the fixed output contract', () => {
  const messages = buildMessages(analyzeLocal(createContext()).context);
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /## 一句话总结/);
  assert.match(messages[0].content, /## 设计思路/);
  assert.match(messages[0].content, /忽略/);
  assert.match(messages[1].content, /project_context/);
  assert.match(messages[1].content, /src\/services\/userService\.ts/);
});
