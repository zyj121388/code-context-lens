import type { ProjectStructure, StructureNode } from '../types';

export interface LayerRailItem {
  key: 'ui' | 'api' | 'service' | 'data' | 'infra';
  label: string;
  active: boolean;
}

export interface FocusedTreeNode {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  selected: boolean;
  children: FocusedTreeNode[];
}

const LAYER_STAGES: Array<Omit<LayerRailItem, 'active'> & { matches: string[] }> = [
  {
    key: 'ui',
    label: '表现',
    matches: ['表现层', '组合层', '状态层'],
  },
  {
    key: 'api',
    label: '接口',
    matches: ['接口层', '入口层'],
  },
  {
    key: 'service',
    label: '业务',
    matches: ['业务层', '领域层', '模块层'],
  },
  {
    key: 'data',
    label: '数据',
    matches: ['数据访问层', '数据层', '集成层'],
  },
  {
    key: 'infra',
    label: '基础',
    matches: ['基础设施层', '共享层', '测试层'],
  },
];

/** Maps the detailed layer name to the five-step architecture rail. */
export function getLayerRail(layer: string): LayerRailItem[] {
  return LAYER_STAGES.map((stage) => ({
    key: stage.key,
    label: stage.label,
    active: stage.matches.includes(layer),
  }));
}

/**
 * Builds a small focused tree: the selected path, plus a few siblings at each
 * level. This keeps both the hover and the panel readable.
 */
export function buildFocusedTree(
  structure: ProjectStructure,
  options: { maxSiblings?: number } = {},
): FocusedTreeNode {
  const maxSiblings = options.maxSiblings ?? 2;
  const segments = structure.selectedPath.split('/').filter(Boolean);
  const root = structure.root;

  const focused = (node: StructureNode, remaining: string[], depth: number): FocusedTreeNode => {
    const view: FocusedTreeNode = {
      name: node.name,
      path: node.path,
      kind: node.kind,
      selected: node.path === structure.selectedPath,
      children: [],
    };
    if (remaining.length === 0 || node.kind === 'file') {
      return view;
    }

    const [next, ...rest] = remaining;
    const selectedChild = node.children.find((child) => child.name === next);
    if (!selectedChild) {
      return view;
    }

    const siblings = node.children
      .filter((child) => child.path !== selectedChild.path)
      .filter((child) => depth === segments.length - 1 || child.kind === 'directory')
      .slice(0, maxSiblings)
      .map<FocusedTreeNode>((child) => ({
        name: child.name,
        path: child.path,
        kind: child.kind,
        selected: false,
        children: [],
      }));

    view.children = [focused(selectedChild, rest, depth + 1), ...siblings];
    return view;
  };

  const rootView = focused(root, segments, 0);
  // Ensure the selected path is visible even if the scanner truncated siblings.
  if (!containsPath(rootView, structure.selectedPath)) {
    const segmentsCopy = [...segments];
    let cursor = rootView;
    while (segmentsCopy.length > 0) {
      const name = segmentsCopy.shift();
      if (!name) {
        break;
      }
      const path = cursor.path ? `${cursor.path}/${name}` : name;
      const child: FocusedTreeNode = {
        name,
        path,
        kind: segmentsCopy.length === 0 ? 'file' : 'directory',
        selected: path === structure.selectedPath,
        children: [],
      };
      cursor.children.unshift(child);
      cursor = child;
    }
  }
  return rootView;
}

/** ASCII tree used by the hover popover and the model context. */
export function compactTreeLines(
  structure: ProjectStructure,
  options: { maxLines?: number; maxSiblings?: number } = {},
): string[] {
  const maxLines = options.maxLines ?? 18;
  const focused = buildFocusedTree(structure, {
    maxSiblings: options.maxSiblings ?? 2,
  });
  const lines: string[] = [];

  const walk = (node: FocusedTreeNode, prefix: string, isLast: boolean, isRoot: boolean): void => {
    if (lines.length >= maxLines) {
      return;
    }
    const connector = isRoot ? '' : isLast ? '└─ ' : '├─ ';
    const suffix = node.selected ? '  ◀ 选中' : '';
    lines.push(
      `${prefix}${connector}${node.name}${node.kind === 'directory' && !isRoot ? '/' : ''}${suffix}`,
    );
    if (node.children.length === 0) {
      return;
    }
    const childPrefix = isRoot ? '' : `${prefix}${isLast ? '   ' : '│  '}`;
    node.children.forEach((child, index) => {
      walk(child, childPrefix, index === node.children.length - 1, false);
    });
  };

  walk(focused, '', true, true);
  if (lines.length >= maxLines) {
    lines.push('…');
  }
  return lines;
}

export function breadcrumbText(structure: ProjectStructure): string {
  return structure.breadcrumb.join(' / ');
}

/** Finds a node by workspace-relative path. */
export function findStructureNode(
  structure: ProjectStructure,
  relativePath: string,
): StructureNode | undefined {
  const segments = relativePath.split('/').filter(Boolean);
  let current: StructureNode | undefined = structure.root;
  for (const segment of segments) {
    current = current?.children.find((child) => child.name === segment);
    if (!current) {
      return undefined;
    }
  }
  return current;
}

function containsPath(node: FocusedTreeNode, path: string): boolean {
  if (node.path === path) {
    return true;
  }
  return node.children.some((child) => containsPath(child, path));
}
