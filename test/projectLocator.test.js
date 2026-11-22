'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderProjectLocator } = require('../out/ui/projectLocator.js');

function result() {
  return {
    markdown: '',
    source: 'local',
    model: 'local-structure',
    requestKey: 'key',
    generatedAt: Date.now(),
    sections: {
      summary: '',
      position: '',
      design: '',
      flow: '',
      relations: '',
      risks: '',
    },
    context: {
      request: {
        uri: 'file:///d:/repo/src/services/userService.ts',
        documentVersion: 1,
        fileName: 'userService.ts',
        relativePath: 'src/services/userService.ts',
        absolutePath: 'D:/repo/src/services/userService.ts',
        languageId: 'typescript',
        startLine: 12,
        endLine: 20,
        startCharacter: 0,
        endCharacter: 1,
        selectedText: 'code',
      },
      project: {
        name: 'demo',
        rootPath: 'D:/repo',
        stack: ['TypeScript'],
        manifests: [],
        topLevel: [],
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
        fingerprint: 'x',
      },
      file: {
        relativePath: 'src/services/userService.ts',
        languageId: 'typescript',
        outline: [],
        imports: [],
        exports: [],
        layer: '业务层',
        role: '业务服务',
      },
      surroundingCode: '',
      related: [],
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
  };
}

test('project locator renders breadcrumbs, layer rail and highlighted file', () => {
  const html = renderProjectLocator(result());
  assert.match(html, /项目定位/);
  assert.match(html, /userService\.ts/);
  assert.match(html, /crumb selected/);
  assert.match(html, /rail-step active/);
  assert.match(html, />业务</);
  assert.match(html, /tree-row selected/);
  assert.match(html, /◀/);
  assert.match(html, /选中 12-20 行/);
});

test('project locator escapes file names', () => {
  const data = result();
  const structure = data.context.project.structure;
  const fileNode = structure.root.children[0].children[0].children[0];
  fileNode.name = '<script>';
  fileNode.path = 'src/services/<script>';
  structure.selectedPath = 'src/services/<script>';
  structure.breadcrumb = ['demo', 'src', 'services', '<script>'];
  const html = renderProjectLocator(data);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});
