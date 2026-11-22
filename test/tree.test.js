'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getLayerRail,
  buildFocusedTree,
  compactTreeLines,
} = require('../out/structure/tree.js');

function structure() {
  const file = (name, path) => ({ name, path, kind: 'file', children: [] });
  const directory = (name, path, children) => ({ name, path, kind: 'directory', children });
  return {
    root: directory('demo', '', [
      directory('src', 'src', [
        directory('services', 'src/services', [
          file('userService.ts', 'src/services/userService.ts'),
          file('orderService.ts', 'src/services/orderService.ts'),
        ]),
        directory('components', 'src/components', [
          file('UserCard.tsx', 'src/components/UserCard.tsx'),
        ]),
      ]),
      directory('tests', 'tests', [file('user.test.ts', 'tests/user.test.ts')]),
    ]),
    selectedPath: 'src/services/userService.ts',
    breadcrumb: ['demo', 'src', 'services', 'userService.ts'],
    totalDirectories: 4,
    totalFiles: 4,
    truncated: false,
  };
}

test('layer rail maps detailed layer to the five-stage architecture', () => {
  const rail = getLayerRail('业务层');
  assert.equal(rail.length, 5);
  assert.equal(rail.find((item) => item.active)?.label, '业务');
  assert.equal(getLayerRail('数据访问层').find((item) => item.active)?.label, '数据');
  assert.equal(getLayerRail('表现层').find((item) => item.active)?.label, '表现');
});

test('focused tree keeps the selected path and a few siblings', () => {
  const tree = buildFocusedTree(structure(), { maxSiblings: 1 });
  assert.equal(tree.children[0].name, 'src');
  const services = tree.children[0].children.find((child) => child.name === 'services');
  assert.ok(services);
  assert.ok(services.children.some((child) => child.selected && child.name === 'userService.ts'));
  assert.ok(services.children.length <= 2);
});

test('compact tree lines mark the selected file and stay bounded', () => {
  const lines = compactTreeLines(structure(), { maxLines: 12, maxSiblings: 1 });
  const text = lines.join('\n');
  assert.match(text, /demo/);
  assert.match(text, /src\//);
  assert.match(text, /userService\.ts  ◀ 选中/);
  assert.ok(lines.length <= 13);
});

test('compact tree still contains the selected path when siblings are truncated', () => {
  const data = structure();
  data.root.children[0].children = data.root.children[0].children.slice(0, 1);
  const text = compactTreeLines(data, { maxLines: 12 }).join('\n');
  assert.match(text, /userService\.ts/);
});
