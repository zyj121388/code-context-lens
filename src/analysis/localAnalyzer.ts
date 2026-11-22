import type { AnalysisResult, AnalysisSections, ContextBundle, RelatedFile } from '../types';
import { requestKey } from '../types';

export function analyzeLocal(context: ContextBundle): AnalysisResult {
  const sections = buildSections(context);
  const markdown = [
    '## 一句话总结',
    sections.summary,
    '',
    '## 它在系统中的位置',
    sections.position,
    '',
    '## 设计思路',
    sections.design,
    '',
    '## 调用链与数据流',
    sections.flow,
    '',
    '## 关联文件',
    sections.relations,
    '',
    '## 风险与改进',
    sections.risks,
  ].join('\n');

  return {
    markdown,
    sections,
    source: 'local',
    model: 'local-structure',
    requestKey: requestKey(context.request),
    context,
    generatedAt: Date.now(),
  };
}

function buildSections(context: ContextBundle): AnalysisSections {
  return {
    summary: buildSummary(context),
    position: buildPosition(context),
    design: buildDesign(context),
    flow: buildFlow(context),
    relations: buildRelations(context.related),
    risks: buildRisks(context),
  };
}

function buildSummary(context: ContextBundle): string {
  const { file, request, detected } = context;
  const symbol = primarySymbol(context);
  const localImport = file.imports.find((item) => !item.external && item.resolvedPath);
  const scope = symbol ? `围绕 \`${symbol}\`` : '以配置/数据声明为主';
  const boundary = localImport
    ? `，把 \`${localImport.resolvedPath}\` 作为协作边界`
    : '';
  return `这段代码位于 **${file.layer}** 的 \`${request.relativePath}\`，承担 **${file.role}**；${scope}${boundary}。`;
}

function primarySymbol(context: ContextBundle): string | undefined {
  const candidates = [
    ...new Set(
      [context.file.enclosingSymbol, ...context.detected.declarations].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  ];
  if (candidates.length === 0) {
    return undefined;
  }

  let best = candidates[0];
  let bestScore = best ? symbolScore(best, context.file.outline) : -1;
  for (const candidate of candidates.slice(1)) {
    const score = symbolScore(candidate, context.file.outline);
    if (score > bestScore || (score === bestScore && candidate.length > (best?.length ?? 0))) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function symbolScore(name: string, outline: string[]): number {
  const line = outline.find((item) => item.includes(name));
  if (!line) {
    return 0;
  }
  if (/Function|Method|Class|Interface|Enum|Constructor|Module|Namespace/.test(line)) {
    return 3;
  }
  if (/Variable|Constant|Property|Field|Parameter/.test(line)) {
    return 1;
  }
  return 2;
}

function buildPosition(context: ContextBundle): string {
  const { file, project, request, related, detected } = context;
  const stack = project.stack.slice(0, 3).join(' + ') || '未识别技术栈';
  const localImport = file.imports.find((item) => !item.external && item.resolvedPath);
  const references = related.filter((item) => item.reason.includes('引用')).length;
  const outlineCount = file.outline.length;
  const symbol = primarySymbol(context);
  const lines: string[] = [];

  lines.push(`- 项目 **${project.name}**（${stack}）· **${file.layer}** / ${file.role}`);
  lines.push(
    localImport
      ? `- 依赖 \`${localImport.resolvedPath}\`${references > 0 ? `；${references} 个模块引用它` : '；未发现直接调用方'}`
      : `- 无项目内直接依赖${references > 0 ? `；${references} 个模块引用它` : ''}`,
  );
  lines.push(
    `- 文件内 ${outlineCount > 0 ? `${outlineCount} 个符号` : '未获取到符号大纲'}${
      symbol ? `，选区在 \`${symbol}\`` : ''
    }`,
  );
  if (detected.routes.length > 0) {
    lines.push(`- 路由：${detected.routes.slice(0, 3).map((route) => `\`${route}\``).join('、')}`);
  }

  return lines.join('\n');
}

function buildDesign(context: ContextBundle): string {
  const { file, detected } = context;
  const lines: string[] = [];

  switch (file.layer) {
    case '表现层':
      lines.push('- 组件负责交互与渲染，业务动作下沉到 Hook / Service；状态与 I/O 不堆在视图里。');
      break;
    case '接口层':
      lines.push('- 入口只做校验、鉴权与协议转换，业务规则交给 Service，避免框架细节渗透。');
      break;
    case '业务层':
      lines.push('- 业务层只编排规则，数据访问通过仓储/端口注入；规则可测试，存储可替换。');
      break;
    case '数据访问层':
      lines.push('- 把查询、事务与映射封装在仓储内，上层只感知数据语义。');
      break;
    case '状态层':
      lines.push('- 集中管理状态转换，异步请求与 UI 事件隔离在外。');
      break;
    case '测试层':
      lines.push('- 测试锁定可观察行为与边界，通过公开接口驱动，而不是复制实现。');
      break;
    case '基础设施层':
    case '共享层':
      lines.push('- 共享/基础设施代码应稳定、无业务语义，避免反向依赖上层。');
      break;
    default:
      lines.push('- 模块边界较清晰；合理性取决于调用方数量与变化频率。');
  }

  if (detected.patterns.length > 0) {
    lines.push(`- 设计信号：**${detected.patterns.slice(0, 3).join('、')}**；间接层提升可测试性，也增加跳转成本。`);
  } else {
    lines.push(`- 当前以${detected.hasAsync ? '异步编排' : '直接过程式代码'}为主；注意分支增长后的可读性。`);
  }

  return lines.join('\n');
}

function buildFlow(context: ContextBundle): string {
  const { detected, request } = context;
  const symbol = primarySymbol(context);
  const entry = symbol
    ? `\`${symbol}\``
    : `\`${request.relativePath}:${request.startLine}\``;
  const chain = detected.calls.slice(0, 6).map((name) => `\`${name}()\``).join(' → ');
  const lines: string[] = [];

  lines.push(`- 调用链：调用方 → ${entry}${chain ? ` → ${chain}` : ''}`);
  lines.push(
    detected.hasAsync
      ? `- 异步路径${detected.hasTryCatch ? '，已有错误处理分支' : '，未识别到错误处理'}。`
      : '- 同步执行；未来接入 I/O 时需重新评估超时与阻塞。',
  );
  if (detected.hasTryCatch) {
    lines.push('- 错误边界：确认 catch 中是恢复/降级，而不是静默吞错。');
  }

  return lines.join('\n');
}

function buildRelations(related: RelatedFile[]): string {
  if (related.length === 0) {
    return '- 未读取到稳定的关联文件。';
  }
  return related
    .slice(0, 4)
    .map((item) => `- \`${item.relativePath}\` — ${item.reason}`)
    .join('\n');
}

function buildRisks(context: ContextBundle): string {
  const { detected, file, request, related } = context;
  const risks: string[] = [];

  if (detected.lineCount >= 60 || detected.branchCount >= 12 || detected.maxIndentDepth >= 5) {
    risks.push(
      `选区约 ${detected.lineCount} 行、${detected.branchCount} 个分支、最大缩进 ${detected.maxIndentDepth}；建议按变化原因拆分。`,
    );
  }
  if (detected.hasAsync && !detected.hasTryCatch) {
    risks.push('异步调用缺少错误处理；确认超时、重试与降级策略。');
  }
  if (/\bconsole\.(log|debug)\b/.test(request.selectedText)) {
    risks.push('选区包含 `console.log/debug`，提交前应移除或改为结构化日志。');
  }
  if (/\bany\b|@ts-ignore|@ts-expect-error/.test(request.selectedText)) {
    risks.push('使用了 `any` 或类型抑制指令，削弱了接口边界。');
  }
  if (/\bTODO\b|\bFIXME\b/.test(request.selectedText)) {
    risks.push('存在 `TODO/FIXME`，设计决策尚未闭环。');
  }
  if (/(fs\.readFileSync|execSync|localStorage)/.test(request.selectedText)) {
    risks.push('存在同步 I/O 或浏览器持久化调用，注意阻塞与隐私。');
  }
  if (
    file.role.includes('业务') &&
    !detected.isTest &&
    related.every((item) => !item.reason.includes('测试'))
  ) {
    risks.push('未找到对应测试；建议覆盖正常、边界与失败路径。');
  }

  if (risks.length === 0) {
    risks.push('未发现明显的结构风险；建议结合真实调用方确认错误语义与并发。');
  }
  return risks.slice(0, 3).map((line) => `- ${line}`).join('\n');
}
