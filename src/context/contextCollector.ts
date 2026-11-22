import * as path from 'node:path';
import * as vscode from 'vscode';
import { logWarn } from '../logger';
import type {
  ContextBundle,
  DetectedFeatures,
  FileContext,
  ImportRef,
  ProjectContext,
  ProjectStructure,
  RelatedFile,
  SelectionRequest,
  StructureNode,
} from '../types';
import { simpleHash, truncate } from '../types';
import { breadcrumbText, compactTreeLines, getLayerRail } from '../structure/tree';
import {
  detectFeatures,
  inferLayer,
  normalizePath,
  parseExports,
  parseImports,
} from './heuristics';

export interface ContextOptions {
  maxContextChars: number;
  surroundingLines: number;
  includeReadme: boolean;
  includeRelatedFiles: boolean;
  maxRelatedFiles: number;
}

interface SymbolNode {
  name: string;
  detail: string;
  kindLabel: string;
  range: vscode.Range;
  selectionRange: vscode.Range;
  depth: number;
}

interface OutlineResult {
  nodes: SymbolNode[];
  enclosing?: SymbolNode;
  outline: string[];
}

interface ReferenceTarget {
  name: string;
  position: vscode.Position;
}

interface ReferenceHit {
  uri: vscode.Uri;
  line: number;
  relativePath: string;
  absolutePath: string;
}

const MANIFEST_NAMES = [
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Gemfile',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  '.eslintrc',
  '.eslintrc.json',
  '.prettierrc',
  'vite.config.ts',
  'next.config.js',
  'nuxt.config.ts',
];

const SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.cs',
  '.json',
];

const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'target',
]);

export class ContextCollector {
  async collect(request: SelectionRequest, options: ContextOptions): Promise<ContextBundle> {
    const uri = vscode.Uri.parse(request.uri);
    const document = await vscode.workspace.openTextDocument(uri);
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const selection = selectionRange(document, request);
    const selectedText = document.getText(selection) || request.selectedText;

    const [project, outline] = await Promise.all([
      this.collectProject(document, folder, request.relativePath),
      this.collectOutline(document, selection),
    ]);

    const imports = parseImports(document.getText(), document.languageId);
    await this.resolveImports(imports, document, folder);
    const exports = parseExports(document.getText(), document.languageId);
    const layer = inferLayer(request.relativePath);
    const file: FileContext = {
      relativePath: request.relativePath,
      languageId: document.languageId,
      outline: outline.outline,
      enclosingSymbol: outline.enclosing?.name,
      imports,
      exports,
      layer: layer.layer,
      role: layer.role,
    };

    const [referenceTarget, surroundingRange] = await Promise.all([
      this.findReferenceTarget(document, selection, outline),
      Promise.resolve(this.expandSurroundingRange(document, selection, outline, options.surroundingLines)),
    ]);
    const referenceHits = referenceTarget
      ? await this.findReferences(referenceTarget, document, folder)
      : [];
    const surroundingCode = document.getText(surroundingRange);
    const related = options.includeRelatedFiles
      ? await this.collectRelatedFiles(
          document,
          folder,
          imports,
          referenceHits,
          outline,
          options.maxRelatedFiles,
        )
      : [];

    const detected = detectFeatures(selectedText, imports, request.relativePath, document.languageId);
    const contextText = buildContextText({
      request,
      project,
      file,
      selectedText,
      surroundingCode,
      related,
      detected,
      maxChars: options.maxContextChars,
    });

    return {
      request: {
        ...request,
        selectedText,
        documentVersion: document.version,
      },
      project,
      file,
      surroundingCode,
      related,
      detected,
      contextText: contextText.text,
      contextChars: contextText.text.length,
      generatedAt: Date.now(),
      hasLanguageServerRefs: referenceHits.length > 0,
    };
  }

  private async collectProject(
    document: vscode.TextDocument,
    folder: vscode.WorkspaceFolder | undefined,
    selectedPath: string,
  ): Promise<ProjectContext> {
    const rootUri = folder?.uri ?? vscode.Uri.file(path.dirname(document.uri.fsPath));
    const rootPath = rootUri.fsPath;
    const name = folder?.name || path.basename(rootPath) || '当前项目';
    const manifests: string[] = [];
    const manifestTexts: string[] = [];

    const rootEntries = await readDirectory(rootUri);
    const rootFiles = rootEntries.filter((entry) => entry.type !== vscode.FileType.Directory).map((entry) => entry.name);

    const selectedManifests = rootFiles
      .filter((fileName) => isManifest(fileName))
      .slice(0, 12);
    for (const fileName of selectedManifests) {
      const uri = vscode.Uri.joinPath(rootUri, fileName);
      const text = await readTextFile(uri, 16000);
      if (text === undefined) {
        continue;
      }
      manifests.push(fileName);
      manifestTexts.push(text);
    }

    // In a monorepo the nearest package.json often describes the file better.
    const nearestPackage = await this.findNearestManifest(document.uri, rootUri, 'package.json');
    if (nearestPackage && !manifests.includes(nearestPackage.relativePath)) {
      manifests.push(nearestPackage.relativePath);
      manifestTexts.push(nearestPackage.text);
    }

    let readmeExcerpt: string | undefined;
    if (folder) {
      const readmeName = rootFiles.find((fileName) => /^readme(\.|$)/i.test(fileName));
      if (readmeName) {
        const readmeUri = vscode.Uri.joinPath(rootUri, readmeName);
        const text = await readTextFile(readmeUri, 12000);
        if (text) {
          readmeExcerpt = summarizeReadme(text);
        }
      }
    }

    const projectName = extractPackageName(manifestTexts) || name;
    const stack = detectStackForProject(manifestTexts, manifests, document.languageId);
    const structure = await this.collectStructure(rootUri, projectName, selectedPath);
    const rootNodes = structure.root.children;
    const topLevel = [
      ...rootNodes
        .filter((node) => node.kind === 'directory')
        .slice(0, 16)
        .map((node) => `${node.name}/`),
      ...rootNodes
        .flatMap((node) =>
          node.kind === 'directory'
            ? node.children
                .filter((child) => child.kind === 'directory')
                .slice(0, 2)
                .map((child) => `${node.name}/${child.name}/`)
            : [],
        )
        .slice(0, 14),
      ...rootNodes
        .filter((node) => node.kind === 'file')
        .slice(0, 16)
        .map((node) => node.name),
    ].slice(0, 48);

    return {
      name: projectName,
      rootPath,
      stack,
      manifests,
      topLevel,
      structure,
      readmeExcerpt,
      fingerprint: simpleHash(
        `${stack.join('|')}::${manifests.join('|')}::${structure.totalDirectories}::${structure.totalFiles}::${readmeExcerpt?.slice(0, 300) ?? ''}`,
      ),
    };
  }

  private async collectStructure(
    rootUri: vscode.Uri,
    projectName: string,
    selectedPath: string,
  ): Promise<ProjectStructure> {
    const root: StructureNode = {
      name: projectName,
      path: '',
      kind: 'directory',
      children: [],
    };
    const budget = { directories: 0, files: 0, truncated: false };
    await this.scanStructure(rootUri, root, 0, selectedPath, budget);
    this.ensureSelectedPath(root, selectedPath, budget);
    const segments = selectedPath.split('/').filter(Boolean);
    return {
      root,
      selectedPath,
      breadcrumb: [projectName, ...segments],
      totalDirectories: budget.directories,
      totalFiles: budget.files,
      truncated: budget.truncated,
    };
  }

  private async scanStructure(
    directoryUri: vscode.Uri,
    node: StructureNode,
    depth: number,
    selectedPath: string,
    budget: { directories: number; files: number; truncated: boolean },
  ): Promise<void> {
    if (depth >= 3) {
      return;
    }
    const entries = await readDirectory(directoryUri);
    const segments = selectedPath.split('/').filter(Boolean);
    const selectedSegment = segments[depth];
    const ordered = [...entries].sort((a, b) => {
      const aSelected = a.name === selectedSegment ? 1 : 0;
      const bSelected = b.name === selectedSegment ? 1 : 0;
      if (aSelected !== bSelected) {
        return bSelected - aSelected;
      }
      const aDirectory = a.type === vscode.FileType.Directory ? 1 : 0;
      const bDirectory = b.type === vscode.FileType.Directory ? 1 : 0;
      if (aDirectory !== bDirectory) {
        return bDirectory - aDirectory;
      }
      return a.name.localeCompare(b.name);
    });

    const maxChildren = 14;
    if (ordered.length > maxChildren) {
      budget.truncated = true;
    }

    for (const entry of ordered.slice(0, maxChildren)) {
      if (entry.type === vscode.FileType.Directory) {
        if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        if (budget.directories >= 80) {
          budget.truncated = true;
          continue;
        }
        budget.directories += 1;
        const childPath = node.path ? `${node.path}/${entry.name}` : entry.name;
        const child: StructureNode = {
          name: entry.name,
          path: childPath,
          kind: 'directory',
          children: [],
        };
        node.children.push(child);
        await this.scanStructure(
          vscode.Uri.joinPath(directoryUri, entry.name),
          child,
          depth + 1,
          selectedPath,
          budget,
        );
      } else {
        if (entry.name.startsWith('.')) {
          continue;
        }
        if (budget.files >= 160) {
          budget.truncated = true;
          continue;
        }
        budget.files += 1;
        const childPath = node.path ? `${node.path}/${entry.name}` : entry.name;
        node.children.push({
          name: entry.name,
          path: childPath,
          kind: 'file',
          children: [],
        });
      }
    }
  }

  private ensureSelectedPath(
    root: StructureNode,
    selectedPath: string,
    budget: { directories: number; files: number; truncated: boolean },
  ): void {
    const segments = selectedPath.split('/').filter(Boolean);
    if (segments.length === 0) {
      return;
    }
    let current = root;
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index];
      if (!name) {
        continue;
      }
      const isFile = index === segments.length - 1;
      const kind: StructureNode['kind'] = isFile ? 'file' : 'directory';
      const childPath = current.path ? `${current.path}/${name}` : name;
      let child = current.children.find((item) => item.name === name && item.kind === kind);
      if (!child) {
        child = {
          name,
          path: childPath,
          kind,
          children: [],
        };
        current.children.unshift(child);
        if (isFile) {
          budget.files += 1;
        } else {
          budget.directories += 1;
        }
      }
      current = child;
    }
  }

  private async collectOutline(document: vscode.TextDocument, selection: vscode.Range): Promise<OutlineResult> {
    const symbols = await withTimeout(
      vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
        'vscode.executeDocumentSymbolProvider',
        document.uri,
      ),
      3000,
      [],
    );

    const nodes = flattenSymbols(symbols ?? []);
    let enclosing: SymbolNode | undefined;
    for (const node of nodes) {
      if (!rangesIntersect(node.range, selection)) {
        continue;
      }
      if (!enclosing) {
        enclosing = node;
        continue;
      }
      if (rangeSize(node.range) < rangeSize(enclosing.range)) {
        enclosing = node;
      }
    }

    const outline = nodes
      .slice(0, 32)
      .map((node) => {
        const start = node.range.start.line + 1;
        const end = node.range.end.line + 1;
        return `${'  '.repeat(Math.min(node.depth, 4))}${node.kindLabel} ${node.name}  (${start}-${end})`;
      });

    return { nodes, enclosing, outline };
  }

  private expandSurroundingRange(
    document: vscode.TextDocument,
    selection: vscode.Range,
    outline: OutlineResult,
    surroundingLines: number,
  ): vscode.Range {
    const maxLines = 240;
    if (outline.enclosing) {
      const symbolLines = outline.enclosing.range.end.line - outline.enclosing.range.start.line + 1;
      if (symbolLines <= maxLines) {
        return outline.enclosing.range;
      }
    }

    const startLine = Math.max(0, selection.start.line - surroundingLines);
    const endLine = Math.min(document.lineCount - 1, selection.end.line + surroundingLines);
    return new vscode.Range(
      new vscode.Position(startLine, 0),
      new vscode.Position(endLine, document.lineAt(endLine).text.length),
    );
  }

  private async resolveImports(
    imports: ImportRef[],
    document: vscode.TextDocument,
    folder: vscode.WorkspaceFolder | undefined,
  ): Promise<void> {
    const root = folder?.uri.fsPath ?? path.dirname(document.uri.fsPath);
    const isPython = document.languageId === 'python';
    await Promise.all(
      imports.slice(0, 16).map(async (item) => {
        if (item.external && !isPython) {
          return;
        }
        const resolved = await resolveLocalImport(
          item.specifier,
          document.uri.fsPath,
          root,
          document.languageId,
        );
        if (resolved) {
          item.resolvedPath = resolved;
          item.external = false;
        }
      }),
    );
  }

  private async findReferenceTarget(
    document: vscode.TextDocument,
    selection: vscode.Range,
    outline: OutlineResult,
  ): Promise<ReferenceTarget | undefined> {
    if (outline.enclosing) {
      return {
        name: outline.enclosing.name,
        position: outline.enclosing.selectionRange.start,
      };
    }

    const selected = document.getText(selection);
    const declaration = /\b(?:function|class|interface|type|enum|const|let|var|def|func|struct)\s+([A-Za-z_$][\w$]*)/.exec(
      selected,
    );
    if (!declaration?.[1]) {
      return undefined;
    }
    const name = declaration[1];
    const offset = selected.indexOf(name);
    if (offset < 0) {
      return undefined;
    }
    const startOffset = document.offsetAt(selection.start);
    const position = document.positionAt(startOffset + offset);
    return { name, position };
  }

  private async findReferences(
    target: ReferenceTarget,
    document: vscode.TextDocument,
    folder: vscode.WorkspaceFolder | undefined,
  ): Promise<ReferenceHit[]> {
    const locations = await withTimeout(
      vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider',
        document.uri,
        target.position,
      ),
      3000,
      [],
    );
    if (!locations || locations.length === 0) {
      return [];
    }

    const root = folder?.uri.fsPath;
    const seen = new Set<string>();
    const hits: ReferenceHit[] = [];
    for (const location of locations) {
      if (location.uri.scheme !== 'file' || location.uri.toString() === document.uri.toString()) {
        continue;
      }
      if (root && !isInsideRoot(location.uri.fsPath, root)) {
        continue;
      }
      const key = location.uri.toString();
      if (seen.has(key) || hits.length >= 8) {
        continue;
      }
      seen.add(key);
      hits.push({
        uri: location.uri,
        line: location.range.start.line + 1,
        relativePath: relativePathOf(location.uri, folder),
        absolutePath: location.uri.fsPath,
      });
    }
    return hits;
  }

  private async collectRelatedFiles(
    document: vscode.TextDocument,
    folder: vscode.WorkspaceFolder | undefined,
    imports: ImportRef[],
    referenceHits: ReferenceHit[],
    outline: OutlineResult,
    maxFiles: number,
  ): Promise<RelatedFile[]> {
    if (maxFiles <= 0) {
      return [];
    }
    const related: RelatedFile[] = [];
    const used = new Set<string>([document.uri.toString()]);

    for (const item of imports) {
      if (related.length >= maxFiles) {
        break;
      }
      if (item.external || !item.resolvedPath) {
        continue;
      }
      const absolutePath = resolveWorkspacePath(item.resolvedPath, folder, document);
      if (!absolutePath) {
        continue;
      }
      const uri = vscode.Uri.file(absolutePath);
      if (used.has(uri.toString())) {
        continue;
      }
      used.add(uri.toString());
      const text = await readTextFile(uri, 9000);
      if (!text) {
        continue;
      }
      related.push({
        relativePath: relativePathOf(uri, folder),
        absolutePath,
        reason: '当前文件直接导入',
        excerpt: truncate(text, 1500),
        line: 1,
      });
    }

    for (const hit of referenceHits) {
      if (related.length >= maxFiles) {
        break;
      }
      if (used.has(hit.uri.toString())) {
        continue;
      }
      used.add(hit.uri.toString());
      const text = await readTextFile(hit.uri, 12000);
      if (!text) {
        continue;
      }
      related.push({
        relativePath: hit.relativePath,
        absolutePath: hit.absolutePath,
        reason: '引用了当前符号',
        excerpt: excerptAroundLine(text, hit.line, 6, 1400),
        line: hit.line,
      });
    }

    if (related.length < maxFiles) {
      const testFile = await findRelatedTest(document.uri, folder);
      if (testFile && !used.has(testFile.toString())) {
        const text = await readTextFile(testFile, 12000);
        if (text) {
          used.add(testFile.toString());
          related.push({
            relativePath: relativePathOf(testFile, folder),
            absolutePath: testFile.fsPath,
            reason: '对应测试文件',
            excerpt: truncate(text, 1600),
            line: 1,
          });
        }
      }
    }

    if (related.length < maxFiles && outline.enclosing) {
      const companion = await findCompanionFile(document.uri, outline.enclosing.name);
      if (companion && !used.has(companion.toString())) {
        const text = await readTextFile(companion, 9000);
        if (text) {
          used.add(companion.toString());
          related.push({
            relativePath: relativePathOf(companion, folder),
            absolutePath: companion.fsPath,
            reason: '同模块的配套文件',
            excerpt: truncate(text, 1200),
            line: 1,
          });
        }
      }
    }

    return related.slice(0, maxFiles);
  }

  private async findNearestManifest(
    documentUri: vscode.Uri,
    rootUri: vscode.Uri,
    fileName: string,
  ): Promise<{ relativePath: string; text: string } | undefined> {
    let current = vscode.Uri.file(path.dirname(documentUri.fsPath));
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = vscode.Uri.joinPath(current, fileName);
      const text = await readTextFile(candidate, 16000);
      if (text !== undefined) {
        return {
          relativePath: relativePathOf(candidate, vscode.workspace.getWorkspaceFolder(rootUri) ?? undefined),
          text,
        };
      }
      const parent = path.dirname(current.fsPath);
      if (parent === current.fsPath || !isInsideRoot(parent, rootUri.fsPath) && parent !== rootUri.fsPath) {
        break;
      }
      current = vscode.Uri.file(parent);
    }
    return undefined;
  }
}

function buildContextText(input: {
  request: SelectionRequest;
  project: ProjectContext;
  file: FileContext;
  selectedText: string;
  surroundingCode: string;
  related: RelatedFile[];
  detected: DetectedFeatures;
  maxChars: number;
}): { text: string } {
  const { request, project, file, selectedText, surroundingCode, related, detected, maxChars } = input;
  const selectedBudget = Math.min(14000, Math.floor(maxChars * 0.38));
  const surroundingBudget = Math.min(16000, Math.floor(maxChars * 0.24));
  const relatedBudget = Math.min(10000, Math.floor(maxChars * 0.22));

  const sections: string[] = [];
  let used = 0;
  const add = (label: string, value: string, budget?: number): void => {
    const remaining = maxChars - used;
    if (remaining <= 80) {
      return;
    }
    const content = truncate(redactSecrets(value.trim()), Math.min(budget ?? remaining, remaining - label.length - 8));
    if (!content) {
      return;
    }
    const block = `${label}\n${content}`;
    sections.push(block);
    used += block.length + 2;
  };

  add(
    '[项目概况]',
    [
      `名称: ${project.name}`,
      `技术栈: ${project.stack.length ? project.stack.join(' + ') : '未识别'}`,
      `顶层结构: ${project.topLevel.slice(0, 28).join(', ')}`,
      `关键清单: ${project.manifests.join(', ') || '无'}`,
      project.readmeExcerpt ? `README 摘要:\n${project.readmeExcerpt}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    Math.floor(maxChars * 0.12),
  );

  const layerRail = getLayerRail(file.layer)
    .map((item) => (item.active ? `【${item.label}】` : item.label))
    .join(' → ');
  add(
    '[项目结构树]',
    [
      `项目定位: ${breadcrumbText(project.structure)}`,
      `架构轨道: ${layerRail}`,
      `项目树:`,
      compactTreeLines(project.structure, { maxLines: 26 }).join('\n'),
      project.structure.truncated ? '(项目树已按体积截断)' : '',
    ]
      .filter(Boolean)
      .join('\n'),
    Math.floor(maxChars * 0.14),
  );

  add(
    `[当前文件 path="${request.relativePath}" language="${request.languageId}"]`,
    [
      `角色: ${file.layer} / ${file.role}`,
      file.enclosingSymbol ? `选区所在符号: ${file.enclosingSymbol}` : '',
      `符号大纲:`,
      file.outline.length ? file.outline.join('\n') : '(语言服务未返回符号大纲)',
      `导入:`,
      file.imports.length
        ? file.imports
            .slice(0, 18)
            .map(
              (item) =>
                `- ${item.specifier}${item.resolvedPath ? ` -> ${item.resolvedPath}` : item.external ? ' (外部包)' : ''}`,
            )
            .join('\n')
        : '(无)',
      `导出: ${file.exports.slice(0, 16).join(', ') || '(未识别)'}`,
    ]
      .filter(Boolean)
      .join('\n'),
    Math.floor(maxChars * 0.18),
  );

  add(
    `[选中代码 lines="${request.startLine}-${request.endLine}"]`,
    fenced(selectedText, request.languageId),
    selectedBudget,
  );

  if (surroundingCode && surroundingCode.trim() !== selectedText.trim()) {
    add(
      '[周边代码（用于理解选区在函数/类中的位置）]',
      fenced(surroundingCode, request.languageId),
      surroundingBudget,
    );
  }

  if (related.length > 0) {
    const perFile = Math.max(700, Math.floor(relatedBudget / related.length));
    for (const item of related) {
      const remaining = maxChars - used;
      if (remaining <= 120) {
        break;
      }
      add(
        `[相关文件 path="${item.relativePath}"${item.line ? ` line="${item.line}"` : ''} reason="${item.reason}"]`,
        fenced(item.excerpt ?? '(未读取到内容)', languageFromPath(item.relativePath)),
        perFile,
      );
    }
  }

  add(
    '[静态信号]',
    [
      `声明: ${detected.declarations.join(', ') || '(无)'}`,
      `调用: ${detected.calls.join(', ') || '(无)'}`,
      `模式: ${detected.patterns.join(', ') || '(无)'}`,
      `路由: ${detected.routes.join(', ') || '(无)'}`,
      `指标: ${detected.lineCount} 行, ${detected.branchCount} 分支, 最大缩进 ${detected.maxIndentDepth}, ${detected.importCount} 导入`,
      `异步: ${detected.hasAsync ? '是' : '否'}, 错误处理: ${detected.hasTryCatch ? '有' : '未识别'}`,
    ].join('\n'),
    Math.floor(maxChars * 0.12),
  );

  let text = sections.join('\n\n');
  if (text.length > maxChars) {
    text = truncate(text, maxChars, '\n[上下文已截断]');
  }
  return { text };
}

function detectStackForProject(
  manifestTexts: string[],
  manifestNames: string[],
  languageId: string,
): string[] {
  const source = manifestTexts.join('\n');
  const stack: string[] = [];
  const rules: Array<[string, RegExp]> = [
    ['Next.js', /\bnext\b/i],
    ['React', /\breact\b/i],
    ['Vue', /\bvue\b/i],
    ['Nuxt', /\bnuxt\b/i],
    ['Angular', /@angular\/core/i],
    ['Svelte', /\bsvelte\b/i],
    ['NestJS', /@nestjs\/core/i],
    ['Express', /\bexpress\b/i],
    ['Fastify', /\bfastify\b/i],
    ['Electron', /\belectron\b/i],
    ['VS Code 扩展', /"vscode"\s*:/i],
    ['Tailwind CSS', /\btailwindcss\b/i],
    ['Prisma', /\bprisma\b/i],
    ['TypeORM', /\btypeorm\b/i],
    ['Mongoose', /\bmongoose\b/i],
    ['Redux', /\bredux\b/i],
    ['Zustand', /\bzustand\b/i],
    ['FastAPI', /\bfastapi\b/i],
    ['Django', /\bdjango\b/i],
    ['Flask', /\bflask\b/i],
    ['SQLAlchemy', /\bsqlalchemy\b/i],
    ['Pydantic', /\bpydantic\b/i],
    ['pytest', /\bpytest\b/i],
    ['Spring Boot', /spring-boot|springframework/i],
    ['Go', /^module\s+\S+/m],
    ['Rust', /\[package\]|cargo/i],
    ['TypeScript', /\btypescript\b|tsconfig/i],
    ['Python', /\bpython\b|pyproject|requirements\.txt/i],
    ['Docker', /FROM\s+\S+|docker-compose/i],
  ];
  for (const [label, pattern] of rules) {
    if (pattern.test(source)) {
      stack.push(label);
    }
  }
  if (manifestNames.some((name) => name.endsWith('package.json')) && !stack.includes('Node.js')) {
    stack.push('Node.js');
  }
  if (languageId === 'typescript' && !stack.includes('TypeScript')) {
    stack.push('TypeScript');
  }
  if (languageId === 'python' && !stack.includes('Python')) {
    stack.push('Python');
  }
  return [...new Set(stack)].slice(0, 7);
}

function flattenSymbols(
  symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>,
  depth = 0,
): SymbolNode[] {
  const result: SymbolNode[] = [];
  for (const symbol of symbols) {
    const isDocumentSymbol = Array.isArray((symbol as vscode.DocumentSymbol).children);
    const range = isDocumentSymbol
      ? (symbol as vscode.DocumentSymbol).range
      : (symbol as vscode.SymbolInformation).location.range;
    const selectionRange = isDocumentSymbol
      ? (symbol as vscode.DocumentSymbol).selectionRange
      : range;
    const kindLabel = vscode.SymbolKind[symbol.kind] ?? 'Symbol';
    result.push({
      name: symbol.name,
      detail: isDocumentSymbol ? (symbol as vscode.DocumentSymbol).detail : '',
      kindLabel,
      range,
      selectionRange,
      depth,
    });
    if (isDocumentSymbol) {
      const children = (symbol as vscode.DocumentSymbol).children;
      result.push(...flattenSymbols(children, depth + 1));
    }
  }
  return result;
}

function selectionRange(document: vscode.TextDocument, request: SelectionRequest): vscode.Range {
  const startLine = clampLine(document, request.startLine - 1);
  const endLine = clampLine(document, request.endLine - 1);
  const startChar = Math.min(request.startCharacter, document.lineAt(startLine).text.length);
  const endChar = Math.min(request.endCharacter, document.lineAt(endLine).text.length);
  return new vscode.Range(new vscode.Position(startLine, startChar), new vscode.Position(endLine, endChar));
}

function clampLine(document: vscode.TextDocument, line: number): number {
  return Math.max(0, Math.min(document.lineCount - 1, line));
}

function rangesIntersect(a: vscode.Range, b: vscode.Range): boolean {
  return !a.end.isBefore(b.start) && !b.end.isBefore(a.start);
}

function rangeSize(range: vscode.Range): number {
  return (range.end.line - range.start.line) * 100000 + (range.end.character - range.start.character);
}

async function readDirectory(
  uri: vscode.Uri,
): Promise<Array<{ name: string; type: vscode.FileType }>> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    return entries.map(([name, type]) => ({ name, type }));
  } catch (error) {
    logWarn(`Unable to read directory ${uri.toString()}: ${String(error)}`);
    return [];
  }
}

async function readTextFile(uri: vscode.Uri, maxChars: number): Promise<string | undefined> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.type & vscode.FileType.Directory) !== 0 || stat.size > 2_000_000) {
      return undefined;
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.includes(0)) {
      return undefined;
    }
    return truncate(new TextDecoder('utf-8').decode(bytes), maxChars);
  } catch {
    return undefined;
  }
}

async function withTimeout<T>(promise: Thenable<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } catch (error) {
    logWarn(`Language provider failed or timed out: ${String(error)}`);
    return fallback;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function resolveLocalImport(
  specifier: string,
  documentPath: string,
  workspaceRoot: string,
  languageId: string,
): Promise<string | undefined> {
  const candidates: string[] = [];
  const documentDir = path.dirname(documentPath);

  if (languageId === 'python') {
    if (specifier.startsWith('.')) {
      let base = documentDir;
      const leadingDots = /^\.+/.exec(specifier)?.[0].length ?? 0;
      for (let index = 1; index < leadingDots; index += 1) {
        base = path.dirname(base);
      }
      const modulePath = specifier.slice(leadingDots).replace(/\./g, '/');
      const target = modulePath ? path.join(base, modulePath) : base;
      candidates.push(`${target}.py`, path.join(target, '__init__.py'));
    } else if (specifier) {
      const modulePath = specifier.replace(/\./g, '/');
      for (const root of [workspaceRoot, path.join(workspaceRoot, 'src'), documentDir]) {
        const target = path.join(root, modulePath);
        candidates.push(`${target}.py`, path.join(target, '__init__.py'));
      }
    }

    const existing = await firstExisting(candidates);
    if (!existing) {
      return undefined;
    }
    const relative = path.relative(workspaceRoot, existing).replace(/\\/g, '/');
    return relative.startsWith('..') ? undefined : relative;
  }

  if (specifier.startsWith('.')) {
    const base = path.resolve(documentDir, specifier);
    candidates.push(base);
    for (const extension of SOURCE_EXTENSIONS) {
      candidates.push(base + extension);
    }
    for (const extension of SOURCE_EXTENSIONS) {
      candidates.push(path.join(base, `index${extension}`));
    }
  } else if (specifier.startsWith('@/') || specifier.startsWith('~/')) {
    const rest = specifier.slice(2);
    for (const root of [path.join(workspaceRoot, 'src'), workspaceRoot]) {
      const base = path.resolve(root, rest);
      candidates.push(base);
      for (const extension of SOURCE_EXTENSIONS) {
        candidates.push(base + extension);
      }
      for (const extension of SOURCE_EXTENSIONS) {
        candidates.push(path.join(base, `index${extension}`));
      }
    }
  } else if (specifier.startsWith('/')) {
    const base = path.resolve(workspaceRoot, `.${specifier}`);
    candidates.push(base);
    for (const extension of SOURCE_EXTENSIONS) {
      candidates.push(base + extension);
    }
  } else {
    return undefined;
  }

  const existing = await firstExisting(candidates);
  if (!existing) {
    return undefined;
  }
  const relative = path.relative(workspaceRoot, existing).replace(/\\/g, '/');
  return relative.startsWith('..') ? undefined : relative;
}

async function firstExisting(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
      if ((stat.type & vscode.FileType.File) !== 0) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

async function findRelatedTest(
  documentUri: vscode.Uri,
  folder: vscode.WorkspaceFolder | undefined,
): Promise<vscode.Uri | undefined> {
  const extension = path.extname(documentUri.fsPath);
  const base = documentUri.fsPath.slice(0, documentUri.fsPath.length - extension.length);
  const candidates = [
    `${base}.test${extension}`,
    `${base}.spec${extension}`,
    path.join(path.dirname(documentUri.fsPath), '__tests__', `${path.basename(base)}.test${extension}`),
    path.join(path.dirname(documentUri.fsPath), '__tests__', `${path.basename(base)}.spec${extension}`),
    path.join(path.dirname(documentUri.fsPath), 'tests', `test_${path.basename(base)}.py`),
    path.join(path.dirname(documentUri.fsPath), 'tests', `${path.basename(base)}_test.py`),
    `${base}_test.go`,
  ];
  const existing = await firstExisting(candidates);
  if (!existing) {
    return undefined;
  }
  if (folder && !isInsideRoot(existing, folder.uri.fsPath)) {
    return undefined;
  }
  return vscode.Uri.file(existing);
}

async function findCompanionFile(
  documentUri: vscode.Uri,
  symbolName: string,
): Promise<vscode.Uri | undefined> {
  const dir = path.dirname(documentUri.fsPath);
  const extension = path.extname(documentUri.fsPath);
  const stem = path.basename(documentUri.fsPath, extension);
  const candidates = [
    path.join(dir, `${stem}.types.ts`),
    path.join(dir, `${stem}.dto.ts`),
    path.join(dir, `${stem}.schema.ts`),
    path.join(dir, `${stem}.module.css`),
    path.join(dir, `${stem}.css`),
    path.join(dir, `${stem}.test.ts`),
    path.join(dir, `${stem}.spec.ts`),
    path.join(dir, `${symbolName}.ts`),
  ];
  const existing = await firstExisting(candidates);
  return existing ? vscode.Uri.file(existing) : undefined;
}

function resolveWorkspacePath(
  relativePath: string,
  folder: vscode.WorkspaceFolder | undefined,
  document: vscode.TextDocument,
): string | undefined {
  const root = folder?.uri.fsPath ?? path.dirname(document.uri.fsPath);
  const absolute = path.resolve(root, relativePath);
  return isInsideRoot(absolute, root) ? absolute : undefined;
}

function isInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function relativePathOf(uri: vscode.Uri, folder: vscode.WorkspaceFolder | undefined): string {
  const relative = folder ? vscode.workspace.asRelativePath(uri, false) : path.basename(uri.fsPath);
  return normalizePath(relative);
}

function isManifest(fileName: string): boolean {
  return MANIFEST_NAMES.includes(fileName) || fileName.endsWith('.csproj');
}

function extractPackageName(manifestTexts: string[]): string | undefined {
  for (const text of manifestTexts) {
    try {
      const parsed = JSON.parse(text) as { name?: unknown };
      if (typeof parsed.name === 'string' && parsed.name.trim()) {
        return parsed.name.trim();
      }
    } catch {
      // Not JSON.
    }
  }
  return undefined;
}

function summarizeReadme(text: string): string {
  const cleaned = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*]\s*/gm, '')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 40)
    .join('\n\n');
  return truncate(cleaned, 1800);
}

function excerptAroundLine(text: string, line: number, radius: number, maxChars: number): string {
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, line - 1 - radius);
  const end = Math.min(lines.length, line + radius);
  return truncate(lines.slice(start, end).join('\n'), maxChars);
}

function fenced(text: string, language: string): string {
  const safeLanguage = language.replace(/[^a-zA-Z0-9#+._-]/g, '').slice(0, 24);
  const safeText = text.replace(/```/g, '``\u200b`');
  return `\`\`\`${safeLanguage}\n${safeText}\n\`\`\``;
}

function languageFromPath(relativePath: string): string {
  const extension = path.extname(relativePath).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'javascript',
    '.jsx': 'jsx',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.kt': 'kotlin',
    '.cs': 'csharp',
    '.vue': 'vue',
    '.svelte': 'svelte',
    '.json': 'json',
    '.css': 'css',
    '.scss': 'scss',
  };
  return map[extension] ?? '';
}

function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(
      /\b(api[_-]?key|secret|password|passwd|token)\b(\s*[:=]\s*)(['"])([^'"]{6,})\3/gi,
      (_match, key: string, separator: string, quote: string) =>
        `${key}${separator}${quote}[REDACTED]${quote}`,
    );
}
