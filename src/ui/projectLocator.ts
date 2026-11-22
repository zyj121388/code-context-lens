import type { AnalysisResult } from '../types';
import { buildFocusedTree, getLayerRail, type FocusedTreeNode } from '../structure/tree';
import { escapeHtml } from './markdown';

export function renderProjectLocator(result: AnalysisResult): string {
  const context = result.context;
  const structure = context.project.structure;
  const rails = getLayerRail(context.file.layer);
  const root = buildFocusedTree(structure, { maxSiblings: 2 });
  const breadcrumbs = structure.breadcrumb
    .map((segment, index) => {
      const isLast = index === structure.breadcrumb.length - 1;
      return `<span class="crumb${isLast ? ' selected' : ''}">${escapeHtml(segment)}</span>`;
    })
    .join('<span class="crumb-sep">/</span>');
  const rail = rails
    .map(
      (item) =>
        `<div class="rail-step${item.active ? ' active' : ''}"><span class="rail-dot"></span><span class="rail-label">${item.label}</span></div>`,
    )
    .join('');

  return `<div class="locator-top">
  <div class="locator-title">
    <div class="eyebrow">项目定位</div>
    <div class="breadcrumb">${breadcrumbs}</div>
  </div>
  <div class="locator-badge">${escapeHtml(context.file.layer)}</div>
</div>
<div class="layer-rail" aria-label="架构层">${rail}</div>
<div class="mini-tree" aria-label="项目结构树">${renderFocusedTree(root, true)}</div>
<div class="locator-foot">
  <span>选中 ${context.request.startLine}-${context.request.endLine} 行</span>
  <span>${context.related.length} 个关联文件</span>
  ${structure.truncated ? '<span>结构已截断</span>' : ''}
</div>`;
}

function renderFocusedTree(node: FocusedTreeNode, isRoot: boolean): string {
  const isDirectory = node.kind === 'directory';
  const marker = node.selected ? '<span class="tree-here">◀</span>' : '';
  const row = `<div class="tree-row${node.selected ? ' selected' : ''}${isDirectory ? ' directory' : ''}"><span class="tree-icon">${isDirectory ? '▸' : '·'}</span><span class="tree-label">${escapeHtml(node.name)}${isDirectory && !isRoot ? '/' : ''}</span>${marker}</div>`;
  const children =
    node.children.length > 0
      ? `<ul class="tree-children">${node.children.map((child) => `<li>${renderFocusedTree(child, false)}</li>`).join('')}</ul>`
      : '';
  return `${row}${children}`;
}
