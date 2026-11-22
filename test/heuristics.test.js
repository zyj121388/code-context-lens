'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  inferLayer,
  parseImports,
  parseExports,
  detectFeatures,
  countBranches,
  detectMaxIndentDepth,
} = require('../out/context/heuristics.js');

test('inferLayer identifies common architectural layers', () => {
  assert.equal(inferLayer('src/services/userService.ts').layer, '业务层');
  assert.equal(inferLayer('src/components/UserCard.tsx').layer, '表现层');
  assert.equal(inferLayer('src/repositories/userRepo.ts').layer, '数据访问层');
  assert.equal(inferLayer('src/controllers/userController.ts').layer, '接口层');
  assert.equal(inferLayer('tests/userService.test.ts').layer, '测试层');
});

test('parseImports extracts relative and external TypeScript imports', () => {
  const text = [
    "import React, { useState } from 'react';",
    "import { repo } from './userRepo';",
    "const fs = require('node:fs');",
  ].join('\n');
  const imports = parseImports(text, 'typescript');
  assert.equal(imports.length, 3);
  assert.equal(imports[0].specifier, 'react');
  assert.equal(imports[0].external, true);
  assert.deepEqual(imports[0].symbols, ['React', 'useState']);
  assert.equal(imports[1].resolvedPath, undefined);
  assert.equal(imports[1].external, false);
  assert.equal(imports[2].packageName, 'node:fs');
});

test('parseImports handles Python from-imports', () => {
  const imports = parseImports('from app.services.user import get_user\nimport os, sys\n', 'python');
  assert.equal(imports[0].specifier, 'app.services.user');
  assert.deepEqual(imports[0].symbols, ['get_user']);
  assert.equal(imports[1].specifier, 'os');
  assert.equal(imports[1].external, true);
});

test('parseExports finds named exports', () => {
  const names = parseExports(
    'export function getUser() {}\nexport class UserService {}\nexport const x = 1;',
    'typescript',
  );
  assert.deepEqual(names, ['getUser', 'UserService', 'x']);
});

test('detectFeatures captures calls, patterns and complexity signals', () => {
  const text = [
    'export async function getUser(id: string) {',
    '  try {',
    '    const user = await repo.findById(id);',
    '    return user ? user : null;',
    '  } catch (error) {',
    '    console.log(error);',
    '  }',
    '}',
  ].join('\n');
  const features = detectFeatures(text, [], 'src/services/userService.ts', 'typescript');
  assert.ok(features.declarations.includes('getUser'));
  assert.ok(features.calls.includes('findById'));
  assert.equal(features.hasAsync, true);
  assert.equal(features.hasTryCatch, true);
  assert.ok(features.patterns.includes('错误处理 / 重试'));
  assert.ok(features.branchCount >= 3);
  assert.ok(features.maxIndentDepth >= 2);
});

test('countBranches and indentation helpers are monotonic', () => {
  assert.ok(countBranches('if (a) { if (b) {} }') > countBranches('if (a) {}'));
  assert.equal(detectMaxIndentDepth('if (a) {\n    b();\n}'), 2);
});
