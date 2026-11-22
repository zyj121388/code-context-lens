import type { DetectedFeatures, ImportRef } from '../types';

const KEYWORDS = new Set([
  'if',
  'else',
  'for',
  'while',
  'switch',
  'case',
  'catch',
  'try',
  'function',
  'return',
  'new',
  'typeof',
  'instanceof',
  'import',
  'require',
  'export',
  'default',
  'await',
  'async',
  'super',
  'constructor',
  'throw',
  'delete',
  'void',
  'yield',
  'with',
  'set',
  'get',
  'of',
  'in',
]);

const STACK_RULES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Next.js', pattern: /\bnext\b/i },
  { label: 'React', pattern: /\breact\b/i },
  { label: 'Vue', pattern: /\bvue\b/i },
  { label: 'Nuxt', pattern: /\bnuxt\b/i },
  { label: 'Angular', pattern: /@angular\/core/i },
  { label: 'Svelte', pattern: /\bsvelte\b/i },
  { label: 'NestJS', pattern: /@nestjs\/core/i },
  { label: 'Express', pattern: /\bexpress\b/i },
  { label: 'Fastify', pattern: /\bfastify\b/i },
  { label: 'Koa', pattern: /\bkoa\b/i },
  { label: 'Electron', pattern: /\belectron\b/i },
  { label: 'VS Code 扩展', pattern: /"vscode"\s*:/i },
  { label: 'React Native', pattern: /\breact-native\b/i },
  { label: 'Tailwind CSS', pattern: /\btailwindcss\b/i },
  { label: 'Prisma', pattern: /\bprisma\b/i },
  { label: 'Drizzle', pattern: /\bdrizzle-orm\b/i },
  { label: 'TypeORM', pattern: /\btypeorm\b/i },
  { label: 'Mongoose', pattern: /\bmongoose\b/i },
  { label: 'Redux', pattern: /\bredux\b/i },
  { label: 'Zustand', pattern: /\bzustand\b/i },
  { label: 'React Query', pattern: /@tanstack\/react-query|\breact-query\b/i },
  { label: 'GraphQL', pattern: /\bgraphql\b|@apollo\//i },
  { label: 'FastAPI', pattern: /\bfastapi\b/i },
  { label: 'Django', pattern: /\bdjango\b/i },
  { label: 'Flask', pattern: /\bflask\b/i },
  { label: 'SQLAlchemy', pattern: /\bsqlalchemy\b/i },
  { label: 'Pydantic', pattern: /\bpydantic\b/i },
  { label: 'pytest', pattern: /\bpytest\b/i },
  { label: 'Spring Boot', pattern: /spring-boot|springframework/i },
  { label: 'ASP.NET', pattern: /Microsoft\.AspNetCore|Microsoft\.NET/i },
  { label: 'TypeScript', pattern: /\btypescript\b|tsconfig/i },
  { label: 'Python', pattern: /\bpython\b|pyproject|requirements\.txt/i },
  { label: 'Go', pattern: /^module\s+\S+/m },
  { label: 'Rust', pattern: /\b(cargo|rustc)\b|\[package\]/i },
  { label: 'Java', pattern: /\b(java|maven|gradle)\b|spring-boot/i },
  { label: 'Docker', pattern: /FROM\s+\S+|docker-compose/i },
  { label: 'GitHub Actions', pattern: /runs-on:|uses:\s+actions\//i },
];

export interface LayerInfo {
  layer: string;
  role: string;
}

export function inferLayer(relativePath: string): LayerInfo {
  const path = normalizePath(relativePath).toLowerCase();
  const lower = path;
  const isTest = /(^|\/)(__tests__|test|tests|spec|specs)(\/|$)|\.(test|spec)\.[^.]+$/.test(lower);

  if (isTest) {
    return { layer: '测试层', role: '自动化测试' };
  }
  if (/(^|\/)(migrations?|schema|schemas|database|db|prisma)(\/|$)/.test(lower)) {
    return { layer: '数据层', role: '数据库结构 / 迁移' };
  }
  if (/(^|\/)(repositories?|repos?|dao|data-access|persistence)(\/|$)/.test(lower)) {
    return { layer: '数据访问层', role: '仓储 / 数据访问' };
  }
  if (/(^|\/)(controllers?|routes?|routers?|handlers?|endpoints?|resources?|api)(\/|$)/.test(lower)) {
    return { layer: '接口层', role: '接口 / 控制器' };
  }
  if (/(^|\/)(services?|usecases?|use-cases?|application|domain|core|logic|business)(\/|$)/.test(lower)) {
    return { layer: '业务层', role: '业务服务 / 领域逻辑' };
  }
  if (/(^|\/)(store|stores|state|reducers?|slices?|actions?)(\/|$)/.test(lower)) {
    return { layer: '状态层', role: '状态管理' };
  }
  if (/(^|\/)(hooks?|composables?)(\/|$)/.test(lower)) {
    return { layer: '组合层', role: '组合式逻辑 / Hook' };
  }
  if (/(^|\/)(components?|pages?|views?|screens?|layouts?|ui|widgets?)(\/|$)/.test(lower)) {
    return { layer: '表现层', role: 'UI 组件 / 页面' };
  }
  if (/(^|\/)(middlewares?|interceptors?|guards?|filters?)(\/|$)/.test(lower)) {
    return { layer: '基础设施层', role: '中间件 / 拦截器' };
  }
  if (/(^|\/)(config|configs|settings|env)(\/|$)|\.(config|conf)\.[^.]+$/.test(lower)) {
    return { layer: '基础设施层', role: '配置' };
  }
  if (/(^|\/)(utils?|helpers?|shared|common|lib|libs)(\/|$)/.test(lower)) {
    return { layer: '共享层', role: '通用工具 / 共享代码' };
  }
  if (/(^|\/)(models?|entities?|types?|interfaces?|dto|dtos)(\/|$)/.test(lower)) {
    return { layer: '领域层', role: '模型 / 数据结构' };
  }
  if (/(^|\/)(api|client|clients|sdk|gateways?)(\/|$)/.test(lower)) {
    return { layer: '集成层', role: '外部接口客户端' };
  }
  if (/(^|\/)(cli|commands?|bin)(\/|$)/.test(lower)) {
    return { layer: '入口层', role: '命令行 / 入口' };
  }
  if (/(^|\/)(main|index|app|server|bootstrap)\.[^.]+$/.test(lower)) {
    return { layer: '入口层', role: '应用入口 / 装配' };
  }

  return { layer: '模块层', role: inferRoleFromExtension(relativePath) };
}

export function inferRoleFromExtension(relativePath: string): string {
  const extension = /\.([^./\\]+)$/.exec(relativePath)?.[1]?.toLowerCase();
  switch (extension) {
    case 'tsx':
    case 'jsx':
    case 'vue':
    case 'svelte':
      return 'UI 组件';
    case 'ts':
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'TypeScript / JavaScript 模块';
    case 'py':
      return 'Python 模块';
    case 'go':
      return 'Go 模块';
    case 'rs':
      return 'Rust 模块';
    case 'java':
    case 'kt':
      return 'JVM 模块';
    case 'cs':
      return 'C# 模块';
    case 'css':
    case 'scss':
    case 'less':
      return '样式模块';
    case 'json':
    case 'yaml':
    case 'yml':
    case 'toml':
      return '配置 / 数据文件';
    case 'md':
      return '文档';
    default:
      return '源码模块';
  }
}

export function detectStack(source: string, manifestNames: string[], languageId: string): string[] {
  const found: string[] = [];
  for (const rule of STACK_RULES) {
    if (rule.pattern.test(source)) {
      found.push(rule.label);
    }
  }
  if (languageId === 'typescript' && !found.includes('TypeScript')) {
    found.push('TypeScript');
  }
  if (languageId === 'python' && !found.includes('Python')) {
    found.push('Python');
  }
  if (manifestNames.some((name) => name.endsWith('package.json')) && !found.includes('Node.js')) {
    found.push('Node.js');
  }
  if (manifestNames.some((name) => name.endsWith('pyproject.toml') || name.endsWith('requirements.txt'))) {
    if (!found.includes('Python')) {
      found.push('Python');
    }
  }
  if (manifestNames.some((name) => name.endsWith('go.mod')) && !found.includes('Go')) {
    found.push('Go');
  }
  if (manifestNames.some((name) => name.endsWith('Cargo.toml')) && !found.includes('Rust')) {
    found.push('Rust');
  }
  return unique(found).slice(0, 7);
}

export function parseImports(text: string, languageId: string): ImportRef[] {
  const results: ImportRef[] = [];

  if (['typescript', 'javascript', 'typescriptreact', 'javascriptreact', 'vue', 'svelte'].includes(languageId)) {
    const importRegex = /^\s*import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(text)) !== null) {
      const clause = match[1]?.trim() ?? '';
      const specifier = match[2]?.trim() ?? '';
      results.push({
        specifier,
        external: isExternalSpecifier(specifier),
        packageName: packageNameFromSpecifier(specifier),
        symbols: parseImportClause(clause),
      });
    }
    const sideEffectRegex = /^\s*import\s+['"]([^'"]+)['"]/gm;
    while ((match = sideEffectRegex.exec(text)) !== null) {
      const specifier = match[1]?.trim() ?? '';
      results.push({
        specifier,
        external: isExternalSpecifier(specifier),
        packageName: packageNameFromSpecifier(specifier),
        symbols: [],
      });
    }
    const requireRegex = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = requireRegex.exec(text)) !== null) {
      const specifier = match[1]?.trim() ?? '';
      results.push({
        specifier,
        external: isExternalSpecifier(specifier),
        packageName: packageNameFromSpecifier(specifier),
        symbols: [],
      });
    }
    const exportFromRegex = /^\s*export\s+(?:\*|\{[\s\S]*?\})\s+from\s+['"]([^'"]+)['"]/gm;
    while ((match = exportFromRegex.exec(text)) !== null) {
      const specifier = match[1]?.trim() ?? '';
      results.push({
        specifier,
        external: isExternalSpecifier(specifier),
        packageName: packageNameFromSpecifier(specifier),
        symbols: [],
      });
    }
  } else if (languageId === 'python') {
    const fromRegex = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+([^#\n]+)/gm;
    let match: RegExpExecArray | null;
    while ((match = fromRegex.exec(text)) !== null) {
      const specifier = match[1]?.trim() ?? '';
      const clause = match[2]?.trim() ?? '';
      results.push({
        specifier,
        external: !specifier.startsWith('.'),
        packageName: specifier.split('.')[0],
        symbols: clause
          .replace(/[()]/g, '')
          .split(',')
          .map((item) => item.trim().split(/\s+as\s+/)[0] ?? '')
          .filter((item) => item && item !== '*'),
      });
    }
    const importRegex = /^\s*import\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*)/gm;
    while ((match = importRegex.exec(text)) !== null) {
      for (const specifier of (match[1] ?? '').split(',').map((item) => item.trim())) {
        if (!specifier) {
          continue;
        }
        results.push({
          specifier,
          external: !specifier.startsWith('.'),
          packageName: specifier.split('.')[0],
          symbols: [],
        });
      }
    }
  } else if (languageId === 'go') {
    const importBlock = /import\s*\(([\s\S]*?)\)/g;
    let block: RegExpExecArray | null;
    while ((block = importBlock.exec(text)) !== null) {
      const itemRegex = /["`]([^"`]+)["`]/g;
      let item: RegExpExecArray | null;
      while ((item = itemRegex.exec(block[1] ?? '')) !== null) {
        const specifier = item[1] ?? '';
        results.push({
          specifier,
          external: !specifier.includes('.'),
          packageName: specifier.split('/')[0],
          symbols: [],
        });
      }
    }
  } else if (['java', 'kotlin', 'csharp'].includes(languageId)) {
    const regex = /^\s*(?:import|using)\s+([\w.*]+)\s*;?/gm;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const specifier = match[1] ?? '';
      results.push({
        specifier,
        external: true,
        packageName: specifier.split('.')[0],
        symbols: [],
      });
    }
  } else if (languageId === 'rust') {
    const regex = /^\s*use\s+([^;]+);/gm;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const specifier = match[1]?.trim() ?? '';
      results.push({
        specifier,
        external: !specifier.startsWith('crate::') && !specifier.startsWith('super::') && !specifier.startsWith('self::'),
        packageName: specifier.split('::')[0],
        symbols: [],
      });
    }
  }

  return dedupeImports(results);
}

export function parseExports(text: string, languageId: string): string[] {
  const names: string[] = [];
  if (['typescript', 'javascript', 'typescriptreact', 'javascriptreact', 'vue', 'svelte'].includes(languageId)) {
    const patterns = [
      /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*export\s*\{\s*([^}]+)\s*\}/gm,
      /^\s*module\.exports\s*=\s*\{?\s*([^};]+)/gm,
    ];
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        names.push(
          ...(match[1] ?? '')
            .split(',')
            .map((item) => item.trim().split(/\s+as\s+/).pop()?.trim() ?? '')
            .filter(Boolean),
        );
      }
    }
  } else if (languageId === 'python') {
    const regex = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const name = match[1] ?? '';
      if (!name.startsWith('_')) {
        names.push(name);
      }
    }
  } else if (languageId === 'go') {
    const regex = /^(?:func|type)\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match[1]) {
        names.push(match[1]);
      }
    }
  }
  return unique(names).slice(0, 30);
}

export function detectFeatures(
  text: string,
  imports: ImportRef[],
  relativePath: string,
  languageId: string,
): DetectedFeatures {
  const declarations = extractDeclarations(text, languageId);
  const calls = extractCalls(text);
  const routes = extractRoutes(text);
  const lowerPath = normalizePath(relativePath).toLowerCase();
  const isTest =
    /(^|\/)(__tests__|test|tests|spec|specs)(\/|$)|\.(test|spec)\.[^.]+$/.test(lowerPath) ||
    /\b(describe|it|test)\s*\(|\bpytest\b|@Test\b|\bassert\b/.test(text);

  return {
    declarations,
    calls,
    routes,
    patterns: detectPatterns(text, imports, declarations, isTest),
    hasAsync: /\bawait\b|\basync\b|\.then\s*\(/.test(text),
    hasTryCatch: /\btry\s*\{|\bcatch\s*\(|except\s+|recover\s*\(/.test(text),
    isTest,
    lineCount: countLines(text),
    branchCount: countBranches(text),
    maxIndentDepth: detectMaxIndentDepth(text),
    importCount: imports.length,
  };
}

export function extractDeclarations(text: string, languageId: string): string[] {
  const found: string[] = [];
  const genericRegex =
    /\b(?:function|class|interface|type|enum|const|let|var|def|struct|record)\s+([A-Za-z_$][\w$]*)/g;
  let match: RegExpExecArray | null;
  while ((match = genericRegex.exec(text)) !== null) {
    if (match[1]) {
      found.push(match[1]);
    }
  }
  if (['java', 'kotlin', 'csharp'].includes(languageId)) {
    const methodRegex =
      /(?:public|private|protected|internal|static|virtual|override|async|final|\s)+[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*\(/g;
    while ((match = methodRegex.exec(text)) !== null) {
      if (match[1] && !KEYWORDS.has(match[1])) {
        found.push(match[1]);
      }
    }
  }
  if (languageId === 'go') {
    const goRegex = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm;
    while ((match = goRegex.exec(text)) !== null) {
      if (match[1]) {
        found.push(match[1]);
      }
    }
  }
  return unique(found).slice(0, 14);
}

export function extractCalls(text: string): string[] {
  const calls: string[] = [];
  const regex = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const name = match[1] ?? '';
    if (!name || KEYWORDS.has(name)) {
      continue;
    }
    calls.push(name);
  }
  return unique(calls).slice(0, 16);
}

export function extractRoutes(text: string): string[] {
  const routes: string[] = [];
  const expressRegex =
    /\b(?:app|router|server|api)\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  let match: RegExpExecArray | null;
  while ((match = expressRegex.exec(text)) !== null) {
    routes.push(`${(match[1] ?? '').toUpperCase()} ${match[2] ?? ''}`);
  }
  const decoratorRegex = /@(Get|Post|Put|Patch|Delete|RequestMapping)\s*\(\s*['"`]?([^'"`)]*)['"`]?\s*\)/g;
  while ((match = decoratorRegex.exec(text)) !== null) {
    routes.push(`${(match[1] ?? '').toUpperCase()} ${match[2] ?? ''}`.trim());
  }
  const flaskRegex = /@\w+\.(get|post|put|patch|delete|route)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  while ((match = flaskRegex.exec(text)) !== null) {
    routes.push(`${(match[1] ?? '').toUpperCase()} ${match[2] ?? ''}`);
  }
  return unique(routes).slice(0, 8);
}

export function countLines(text: string): number {
  if (!text) {
    return 0;
  }
  return text.split(/\r?\n/).length;
}

export function countBranches(text: string): number {
  const patterns = [/\bif\b/g, /\belse\s+if\b/g, /\bswitch\b/g, /\bcase\b/g, /\bcatch\b/g, /\bfor\b/g, /\bwhile\b/g, /&&/g, /\|\|/g, /\?/g];
  return patterns.reduce((total, pattern) => total + (text.match(pattern)?.length ?? 0), 1);
}

export function detectMaxIndentDepth(text: string): number {
  let max = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const leading = /^[ \t]*/.exec(line)?.[0] ?? '';
    const spaces = leading.replace(/\t/g, '  ').length;
    max = Math.max(max, Math.floor(spaces / 2));
  }
  return max;
}

export function inferLayerFromPath(relativePath: string): string {
  return inferLayer(relativePath).layer;
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function detectPatterns(
  text: string,
  imports: ImportRef[],
  declarations: string[],
  isTest: boolean,
): string[] {
  const patterns: string[] = [];
  if (/\buse[A-Z]\w*\s*\(/.test(text)) {
    patterns.push('React Hooks');
  }
  if (/@Injectable|@Autowired|\binject\s*\(|\bDepends\s*\(|\bProvider\s*\(/.test(text)) {
    patterns.push('依赖注入');
  }
  if (/\bRepository\b|\brepository\b|\bdao\b/.test(text) || imports.some((item) => /repo/i.test(item.specifier))) {
    patterns.push('仓储 / 数据访问');
  }
  if (/\bFactory\b|\bcreate\w+\s*\(|\bbuilder\b/i.test(text)) {
    patterns.push('工厂 / 构建器');
  }
  if (/\bEventEmitter\b|\baddEventListener\b|\bsubscribe\s*\(|\bemit\s*\(|\bon[A-Z]\w*\s*\(/.test(text)) {
    patterns.push('事件 / 观察者');
  }
  if (/\bmiddleware\b|\bnext\s*\(|\binterceptor\b/i.test(text)) {
    patterns.push('中间件管道');
  }
  if (/\btransaction\b|\bBEGIN\b|\bCOMMIT\b|\brollback\b/i.test(text)) {
    patterns.push('事务边界');
  }
  if (/\btry\s*\{|\bcatch\s*\(|\bretry\b|\bbackoff\b/i.test(text)) {
    patterns.push('错误处理 / 重试');
  }
  if (/\buseState\b|\buseReducer\b|\bref\s*\(|\breactive\s*\(/.test(text)) {
    patterns.push('响应式状态');
  }
  if (/\bfetch\s*\(|\baxios\b|\bhttp\.|\brequest\s*\(/.test(text)) {
    patterns.push('外部 I/O');
  }
  if (/\bmap\s*\(|\bfilter\s*\(|\breduce\s*\(/.test(text)) {
    patterns.push('集合变换');
  }
  if (isTest) {
    patterns.push('测试断言');
  }
  if (declarations.some((name) => /Service$|UseCase$/i.test(name))) {
    patterns.push('服务分层');
  }
  return unique(patterns).slice(0, 7);
}

function parseImportClause(clause: string): string[] {
  const symbols: string[] = [];
  const defaultImport = /^([A-Za-z_$][\w$]*)/.exec(clause);
  if (defaultImport?.[1]) {
    symbols.push(defaultImport[1]);
  }
  const named = /\{([^}]*)\}/.exec(clause);
  if (named?.[1]) {
    symbols.push(
      ...named[1]
        .split(',')
        .map((item) => item.trim().split(/\s+as\s+/)[0] ?? '')
        .filter(Boolean),
    );
  }
  const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
  if (namespace?.[1]) {
    symbols.push(namespace[1]);
  }
  return unique(symbols).slice(0, 16);
}

function isExternalSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('@/') && !specifier.startsWith('~/');
}

function packageNameFromSpecifier(specifier: string): string | undefined {
  if (!isExternalSpecifier(specifier)) {
    return undefined;
  }
  const parts = specifier.split('/');
  if (specifier.startsWith('@') && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function dedupeImports(imports: ImportRef[]): ImportRef[] {
  const seen = new Set<string>();
  const result: ImportRef[] = [];
  for (const item of imports) {
    const key = `${item.specifier}::${item.symbols.join(',')}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
