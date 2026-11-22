/**
 * Shared, vscode-free data model. Keeping these types independent from the
 * editor API makes the context builders and analyzers easy to test.
 */

export type OutputLanguage = 'zh-CN' | 'en';

export type ProviderKind = 'auto' | 'deepseek' | 'openai' | 'ollama' | 'local';

export type ResolvedProviderKind = Exclude<ProviderKind, 'auto' | 'local'>;

export interface SelectionRequest {
  /** URI string, e.g. file:///d:/repo/src/a.ts */
  uri: string;
  documentVersion: number;
  fileName: string;
  /** Workspace-relative path with forward slashes when possible. */
  relativePath: string;
  absolutePath: string;
  languageId: string;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  startCharacter: number;
  endCharacter: number;
  selectedText: string;
  workspaceRoot?: string;
  workspaceName?: string;
}

export interface SelectionAnchor {
  uri: string;
  documentVersion: number;
  startLine: number;
  endLine: number;
  startCharacter: number;
  endCharacter: number;
}

export interface StructureNode {
  name: string;
  /** Workspace-relative path, e.g. src/services/userService.ts */
  path: string;
  kind: 'directory' | 'file';
  children: StructureNode[];
}

export interface ProjectStructure {
  root: StructureNode;
  /** Relative path of the selected file. */
  selectedPath: string;
  /** Project name + path segments, used for breadcrumbs. */
  breadcrumb: string[];
  totalDirectories: number;
  totalFiles: number;
  truncated: boolean;
}

export interface ProjectContext {
  name: string;
  rootPath: string;
  /** Human-readable stack labels, e.g. React, TypeScript, Vite. */
  stack: string[];
  manifests: string[];
  topLevel: string[];
  /** Compact, automatically built project tree with the selected file on its path. */
  structure: ProjectStructure;
  readmeExcerpt?: string;
  /** 0-100, used for cache invalidation hints. */
  fingerprint: string;
}

export interface ImportRef {
  specifier: string;
  /** Workspace-relative resolved path, when the import points inside the repo. */
  resolvedPath?: string;
  external: boolean;
  packageName?: string;
  symbols: string[];
}

export interface FileContext {
  relativePath: string;
  languageId: string;
  /** Indented outline, e.g. "class UserService  (12-98)". */
  outline: string[];
  enclosingSymbol?: string;
  imports: ImportRef[];
  exports: string[];
  /** Inferred architectural layer. */
  layer: string;
  /** Inferred file role. */
  role: string;
}

export interface RelatedFile {
  relativePath: string;
  /** Absolute path, used by the panel to open the file. */
  absolutePath: string;
  reason: string;
  excerpt?: string;
  /** 1-based line of the interesting location. */
  line?: number;
}

export interface DetectedFeatures {
  declarations: string[];
  calls: string[];
  patterns: string[];
  routes: string[];
  hasAsync: boolean;
  hasTryCatch: boolean;
  isTest: boolean;
  lineCount: number;
  branchCount: number;
  maxIndentDepth: number;
  importCount: number;
}

export interface ContextBundle {
  request: SelectionRequest;
  project: ProjectContext;
  file: FileContext;
  surroundingCode: string;
  related: RelatedFile[];
  detected: DetectedFeatures;
  /** Serialized context that is sent to the model. */
  contextText: string;
  contextChars: number;
  generatedAt: number;
  /** True when the provider can read references from the language server. */
  hasLanguageServerRefs: boolean;
}

export interface AnalysisSections {
  summary: string;
  position: string;
  design: string;
  flow: string;
  relations: string;
  risks: string;
}

export interface AnalysisResult {
  markdown: string;
  sections: AnalysisSections;
  source: 'local' | 'ai';
  model?: string;
  requestKey: string;
  context: ContextBundle;
  generatedAt: number;
}

export interface ProviderInfo {
  kind: ResolvedProviderKind | 'local';
  label: string;
  model: string;
  baseUrl: string;
  available: boolean;
  /** Why the provider is unavailable, or a hint when it is available. */
  reason?: string;
  requiresKey: boolean;
}

export type DeepState =
  | 'idle'
  | 'warming'
  | 'streaming'
  | 'done'
  | 'error'
  | 'unavailable';

export interface DeepStatus {
  state: DeepState;
  message?: string;
  provider?: string;
  model?: string;
}

export interface RequestKeyInput {
  uri: string;
  documentVersion: number;
  startLine: number;
  endLine: number;
  startCharacter: number;
  endCharacter: number;
  selectedText: string;
}

export function buildRequestKey(input: RequestKeyInput): string {
  return [
    input.uri,
    input.documentVersion,
    input.startLine,
    input.startCharacter,
    input.endLine,
    input.endCharacter,
    simpleHash(input.selectedText),
  ].join('::');
}

export function requestKey(request: SelectionRequest): string {
  return buildRequestKey(request);
}

export function toAnchor(request: SelectionRequest): SelectionAnchor {
  return {
    uri: request.uri,
    documentVersion: request.documentVersion,
    startLine: request.startLine,
    endLine: request.endLine,
    startCharacter: request.startCharacter,
    endCharacter: request.endCharacter,
  };
}

/** Small, stable non-cryptographic hash used only for cache keys. */
export function simpleHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function truncate(value: string, maxChars: number, suffix = '…'): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd() + suffix;
}
