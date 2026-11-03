/**
 * dsh-agent-code-tutor —— 把编辑器当手和眼。
 *
 * 分工:对话在 DSH(这里),代码在编辑器(那边是 agent_code_tutor 那个 VS Code 扩展)。
 * 插件只做两件事 —— **让它看得见**(场景、文件、人做了什么)和 **让它动得准**
 * (写、指、交棒)。
 *
 * 九个工具:
 *   editor_ping    连通性 + 有哪些能力
 *   editor_look    看:前台文件、光标、未落盘、上次调用以来人做了什么
 *   editor_read    读编辑器里的内容(内存 buffer,含未保存改动)
 *   editor_open    打开并聚焦(写之前必须先做)
 *   editor_insert  插一段文本
 *   editor_replace 替换一段(或整份)
 *   editor_point   指:高亮若干段 + 行尾注解(不改代码)
 *   editor_wait    交棒:等人点「继续 / 暂停」
 *   editor_confirm_create  确认新建文件(会弹窗问人),写入后同样交棒
 *
 * 写类工具(insert / replace / confirm_create)都**自带交棒**:返回时人已经按过按钮。
 * 这不是提示词的约束,是工具的结构 —— 模型没有"接着写"这个选项。
 *
 * 注意:**落盘(save)和清浮层(clear)没有开放给 agent** —— 存不存、擦不擦由人决定。
 *
 * 工具定义按 Context.tools.register 的原始契约手写,不 import 任何运行时包。
 * 唯一的例外是 `@deepseek-ai/schemastery` —— 设置页的表单 schema 需要它;
 * 裸导入失败时会从 DSH 自己的安装位置借一个 require(见 loadSchema),
 * 两种安装方式(link: 与 registry/github)都能跑。
 *
 * 会话 token 不再单独配置 —— 每条会话绑定自带一个(token 标识工作区)。
 * 没有绑定时,仍按下面的顺序兜底取一个"默认 token":
 *   1. DSH 设置页里的表单 / cordis.patch.yml 里该条目的 config
 *   2. 环境变量 EDITOR_API_PORT / EDITOR_API_TOKEN
 *   3. 插件目录下的 config.json
 *   4. 自动发现:扫 cwd 及其直接子目录的 .vscode/settings.json 里的 tutorApi.conversationToken
 *   5. 默认值:端口 41890,token 空(空的话每个请求都会被拒)
 *
 * 空字符串一律当作"没配" —— 设置页的默认值不会盖住后面几层。
 *
 * @module dsh-agent-code-tutor
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Bridge, DEFAULT_PORT } from './lib/bridge.js';

export const name = 'dsh-agent-code-tutor';
export const inject = ['tools', 'systemPrompt', 'agents', 'skills'];

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 加载 schemastery —— 设置页的表单是从它生成的。
 *
 * 为什么要兜底:以 `link:` 装进来的插件,真实路径在工作区里,往上找不到
 * 任何 node_modules;而正常安装(github:/registry)时它就躺在 profile 的
 * node_modules 下,一路向上就能解析到。两种都要能跑,所以先试裸导入,
 * 失败再从 DSH 自己的安装位置借一个 require。
 */
async function loadSchema() {
  try {
    const mod = await import('@deepseek-ai/schemastery');
    return mod.default ?? mod;
  } catch {}
  try {
    const { createRequire } = await import('node:module');
    const entry = process.argv[1];
    if (!entry) return null;
    return createRequire(fs.realpathSync(entry))('@deepseek-ai/schemastery');
  } catch {
    return null;
  }
}

const Schema = await loadSchema();

/**
 * 插件配置:设置页读这个 schema 生成表单。
 *
 * 拿不到 schemastery 时导出 undefined —— 插件照常工作,只是设置页没有表单
 * (开发时用 link: 安装就会这样,改 config.json 或环境变量即可)。
 */
export const Config = Schema
  ? Schema.object({
      // 注意 .volatile():DSH 的设置页只把**标了 volatile 的字段**
      // 当成可配置项(dsh-settings 的 volatileForm 过滤),没有这个标记的字段
      // 整条会被跳过 —— 页面上就表现为"设置服务不可用"。
      port: Schema.number()
        .default(DEFAULT_PORT)
        .volatile()
        .description('VS Code 扩展监听的端口,要和扩展设置 tutorApi.port 一致'),
      bindings: Schema.string()
        .default('')
        .volatile()
        .description(
          '会话绑定:<会话id>=<token>,多条用分号分隔。收到带 token 的问话就送给对应会话;' +
            '工具调用也会用该会话绑定的 token 去连。留空则退到"恰好一个活跃会话"',
        ),
    })
  : undefined;

/** skill 正文随包发:改这个文件不用改代码。 */
const SKILL_BODY = fs.readFileSync(path.join(HERE, 'skills/editor-tutor/SKILL.md'), 'utf8');

/** 普通 op 的上限。写入/读取都在本地,30 秒足够。 */
const OP_TIMEOUT_MS = 30000;
/**
 * 交棒不设超时(0 = 一直等)。
 *
 * 用户在读代码 —— DSH 这边等工具回复不烧 token、不占资源;设了超时反而会让 agent
 * 在用户离开时自己继续往下讲,白烧钱。DSH 死了连接就断,调用自然结束。
 */
const WAIT_FOREVER = 0;


// ── 配置 ────────────────────────────────────────────────────

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 没人配置 token 时,自己去工作区里找。
 *
 * 扩展把 token 写在**它打开的那个文件夹**的 .vscode/settings.json 里。DSH 的 cwd
 * 通常是这些文件夹的公共父目录,所以扫一遍直接子目录就够了。
 *
 * 找到多个不同的值时不猜 —— 猜错等于连错会话,宁可报错让人填。
 */
function discoverToken(cwd) {
  const found = [];
  const readFrom = (file) => {
    const value = readJsonFile(file)?.['tutorApi.conversationToken'];
    if (typeof value === 'string' && value.trim()) found.push({ token: value.trim(), file });
  };
  try {
    readFrom(path.join(cwd, '.vscode/settings.json'));
    for (const entry of fs.readdirSync(cwd, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      readFrom(path.join(cwd, entry.name, '.vscode/settings.json'));
    }
  } catch {
    return null;
  }
  const distinct = new Map(found.map((item) => [item.token, item]));
  return distinct.size === 1 ? found[0] : null;
}

/**
 * 解析绑定表:`<sessionId>=<token>`,换行或分号分隔,`#` 开头是注释。
 *
 * 也用分号,是因为设置页里的输入框是单行的 —— 多行输入在那边不容易写。
 * 等号可以省略,用空格/Tab 分隔也认。
 *
 * @returns {{ byToken: Map<string,string>, bySession: Map<string,string> }}
 */
function parseBindings(text) {
  const byToken = new Map();
  const bySession = new Map();
  for (const raw of String(text ?? '').split(/[\n;]/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([^\s=]+)\s*[=]?\s*([^\s=]+)$/.exec(line);
    if (!match) continue;
    const [, sessionId, token] = match;
    byToken.set(token, sessionId);
    bySession.set(sessionId, token);
  }
  return { byToken, bySession };
}

/** 取第一个"真的有内容"的值 —— 空字符串、undefined 都算没配。 */
function pick(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

function resolveConfig(passed) {
  const local = readJsonFile(path.join(HERE, 'config.json')) ?? {};
  // 注意 config 里的默认值(端口 41890 / token 空)不能盖住环境变量和 config.json,
  // 所以用 pick 而不是 ?? —— 空字符串要当成"没配"。
  const port = Number(pick(passed?.port, process.env.EDITOR_API_PORT, local.port)) || DEFAULT_PORT;

  let token = String(pick(passed?.token, process.env.EDITOR_API_TOKEN, local.token) ?? '');
  let discoveredFrom = null;
  if (!token) {
    const found = discoverToken(process.cwd());
    if (found) {
      token = found.token;
      discoveredFrom = found.file;
    }
  }
  const bindingsText = String(pick(passed?.bindings, process.env.EDITOR_API_BINDINGS, local.bindings) ?? '');

  return { port, token, bindings: parseBindings(bindingsText), discoveredFrom };
}

// ── 系统提示 ────────────────────────────────────────────────

const RULES = `## 编辑器就是你的手和眼

用户想看着代码学("教我写 X""陪我做 Y""边写边讲")时,用 editor_* 工具把编辑器当黑板。对话仍然在这里。

· **写之前先 open**:写操作要求目标文件在前台,不然会被拒。这不是麻烦,是承诺 —— 你不在用户看不见的地方改代码。
· **一次写一小段**(建议 ≤20 行)。写完就 editor_wait 交棒,用户按「继续」你才往下讲。写多了也照写,但返回里会提醒你 —— 那是教学节奏,不是性能限制。
· **讲已有代码用 editor_point**,不要为了指一下就改代码。可以一次标好几段不连续的。
· **读用 editor_read**,它读的是内存 buffer,含用户没保存的改动 —— 别用别的工具猜文件内容。
· editor_wait 返回 ended:
  - \`confirm\` —— 用户看完了,接着讲;
  - \`abort\` —— 用户点了暂停,**这一拍的写入已经被撤回**(代码回到写之前)。别接着写,问一句"哪里不对"。
· 解释只说"为什么这样写",不说"这是什么语法"。
· 普通改代码不要用这些工具:那会写进用户眼前的编辑器,而不是 DSH 工作区的文件。`;

// ── 文本小工具 ──────────────────────────────────────────────

const textBlocks = (text) => [{ type: 'text', text }];

/** 带行号的代码块 —— 行号让模型能准确说出"第几行"。 */
function numbered(text, startLine) {
  return String(text ?? '')
    .replace(/\n$/, '')
    .split('\n')
    .map((line, index) => `${startLine + index}| ${line}`)
    .join('\n');
}

/** 场景 → 一段人话。 */
function describeScene(scene) {
  if (!scene) return '(没有场景信息)';
  const parts = [];
  const active = scene.active;
  if (active) {
    const cursor = active.cursor ? ` · 光标 ${active.cursor.line}:${active.cursor.character}` : '';
    const dirty = active.dirty ? ' · **未保存**' : '';
    parts.push(`前台:${active.path}${cursor}${dirty}`);
    if (active.selection) {
      const { start, end, text } = active.selection;
      parts.push(`选中:${start.line}:${start.character} → ${end.line}:${end.character}`);
      if (text) parts.push('```', text.slice(0, 600), '```');
    }
  } else {
    parts.push('前台:没有打开文字文件');
  }
  const others = (scene.files ?? []).filter((file) => file.path !== active?.path).slice(0, 8);
  if (others.length > 0) {
    parts.push(`其他打开的:${others.map((f) => `${f.path}${f.dirty ? '*' : ''}`).join(', ')}`);
  }
  if ((scene.dirty ?? []).length > 0) parts.push(`未落盘:${scene.dirty.join(', ')}`);
  return parts.join('\n');
}

/** 事件 → 一段人话。事件被取走就没了,所以这里要一次说清。 */
function describeEvents(events) {
  if (!events) return '';
  const recent = events.recent ?? [];
  const older = events.older ?? {};
  const lines = [];
  for (const event of recent) {
    const label = { change: '改了', save: '保存了', open: '打开了', close: '关闭了', focus: '切到' }[event.t] ?? event.t;
    lines.push(`- ${label} ${event.file}`);
  }
  const rest = Object.entries(older)
    .map(([kind, count]) => `${kind}×${count}`)
    .join(' ');
  if (rest) lines.push(`- 更早还有:${rest}`);
  if (lines.length === 0) return '';
  return `\n\n**你不在的时候,用户: **\n${lines.join('\n')}`;
}

// ── 工具定义(手写 Context.tools.register 契约)────────────────

/** 所有工具的输出契约:一段给人看的话。 */
/** 文件不存在时的统一说明:告诉模型调哪个工具、带什么参数。 */
function needConfirmReport(pending, op) {
  return (
    `◆ 文件不存在:${pending.file}(没创建,内容已暂存 ${pending.chars} 字符)\n\n` +
    `确认要新建,就调 \`editor_confirm_create\`(op:"${op}", file:"${pending.file}", confirm:"${pending.token}")。` +
    `它走 DSH 的审批通道 —— 权限不够会问人。内容已暂存,不用重发 text,${pending.expiresIn} 秒内有效。`
  );
}

const REPORT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      report: { type: 'string', description: '这次调用发生了什么' },
    },
    required: ['report'],
  },
  render: (_args, value) => textBlocks(String(value?.report ?? '')),
};

const FILE_PROPERTY = {
  type: 'string',
  description: '相对编辑器里打开的文件夹的路径,例如 "src/ops.js"。**必须给** —— 工具不会替你猜前台文件',
};

/**
 * 注册前把 JSON Schema 自查一遍。
 *
 * 踩过:手写 schema 时把 `required: true` 留在字段上,整个工具表被模型 API 拒绝,
 * 而 `tools.register` 并不校验 parameters —— 宁可在插件加载时炸,也别在会话里炸。
 */
function assertSchema(node, at) {
  if (node === null || typeof node !== 'object') return;
  if ('required' in node && !Array.isArray(node.required)) {
    throw new Error(`${at}: JSON Schema 的 required 必须是字符串数组,拿到 ${JSON.stringify(node.required)}`);
  }
  if ('enum' in node && !Array.isArray(node.enum)) {
    throw new Error(`${at}: enum 必须是数组`);
  }
  for (const [key, child] of Object.entries(node.properties ?? {})) assertSchema(child, `${at}.${key}`);
  if (node.items) assertSchema(node.items, `${at}[]`);
}

function editorTool({ name: toolName, description, parameters, execute }) {
  assertSchema(parameters, `${toolName}.parameters`);
  assertSchema(REPORT_OUTPUT.schema, `${toolName}.output`);
  return { name: toolName, description, parameters, output: REPORT_OUTPUT, execute };
}

// ── 工具实现 ────────────────────────────────────────────────

function createTools(bridge, tokenForSession) {
  /**
   * 调一次编辑器,拿整个信封。
   *
   * token 按**发起这次调用的会话**挑:一个插件可能同时绑着多块编辑器工作区,
   * 用错 token 就会被对面的扩展拒掉。
   */
  const call = (exec, op, params, options = {}) => {
    const sessionId = exec?.agent?.id;
    const boundToken = sessionId ? tokenForSession(sessionId) : undefined;
    return bridge.request(op, params, {
      signal: exec.signal,
      ...(boundToken ? { token: boundToken } : {}),
      timeoutMs: OP_TIMEOUT_MS,
      ...options,
    });
  };

  /**
   * 写完就交棒 —— 由**工具**执行,不靠模型自觉。
   *
   * 为什么:模型完全可能写完一段接着写下一段,人还没读。把 wait 焊在写操作里,
   * 它就没有"继续写"这个选项了 —— 只能停下来等人点继续。
   *
   * @returns {string} 交棒结果的描述
   */
  const handoff = async (exec) => {
    const sessionId = exec?.agent?.id;
    const boundToken = sessionId ? tokenForSession(sessionId) : undefined;
    const response = await bridge.request('wait', { timeoutMs: 0 }, {
      signal: exec.signal,
      ...(boundToken ? { token: boundToken } : {}),
      timeoutMs: WAIT_FOREVER,
    });
    const result = response.result ?? {};
    const extra = describeEvents(result.events);
    if (result.ended === 'abort') {
      return `⏸ 用户点了暂停 —— **这一拍的写入已经被撤回**,代码回到写之前。\n\n先别接着写,问一句"哪里不对"。${extra}`;
    }
    if (result.ended === 'timeout') return `⏸ 等太久了,没有回应。${extra}`;
    return `▶ 用户继续了。${extra}`;
  };

  const ping = editorTool({
    name: 'editor_ping',
    description: '检查编辑器能不能连上;顺带告诉你它支持哪些能力。连不上时先调这个。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_args, exec) {
      const response = await call(exec, 'ping');
      return { report: `✓ 编辑器在线 · ${(response.result?.ops ?? []).join(', ')}` };
    },
  });

  const look = editorTool({
    name: 'editor_look',
    description: '看编辑器现在的样子:前台文件、光标、选区、哪些文件没保存,以及上次调用以来用户做了什么。动手之前先看一眼。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_args, exec) {
      const response = await call(exec, 'scene');
      return { report: describeScene(response.result) + describeEvents(response.events) };
    },
  });

  const read = editorTool({
    name: 'editor_read',
    description: '读编辑器里的文件内容(内存 buffer,含未保存改动)。默认前 200 行,返回里带总行数。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: FILE_PROPERTY,
        from: { type: 'number', description: '起始行(从 1 开始),默认 1' },
        to: { type: 'number', description: '结束行(含),默认 from+199' },
      },
      required: ['file'],
    },
    async execute(args, exec) {
      const response = await call(exec, 'read', { file: args.file, from: args.from, to: args.to });
      const result = response.result ?? {};
      const head = `◆ ${result.path} · 第 ${result.from}-${result.to} 行,共 ${result.totalLines} 行${result.dirty ? ' · **未保存**' : ''}`;
      const body = numbered(result.text, result.from);
      const more = result.to < result.totalLines ? `\n\n(还有 ${result.totalLines - result.to} 行没读)` : '';
      return { report: `${head}\n\`\`\`\n${body}\n\`\`\`${more}` };
    },
  });

  const open = editorTool({
    name: 'editor_open',
    description: '把文件打开并带到前台。写之前必须先做这一步 —— 写操作要求目标文件在前台。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { file: FILE_PROPERTY },
      required: ['file'],
    },
    async execute(args, exec) {
      const response = await call(exec, 'open', { file: args.file });
      return { report: `◆ 已打开 ${response.result?.path}${response.result?.dirty ? '(未保存)' : ''}` };
    },
  });

  const insert = editorTool({
    name: 'editor_insert',
    description:
      '在文件里插入一段文本。目标文件必须在前台(先 editor_open)。**写完会自动停下来等人点继续** —— 不用再调 editor_wait。教学场景一次别超过 20 行。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: FILE_PROPERTY,
        text: { type: 'string', description: '要插入的文本;换行用 \\n' },
        at: {
          type: 'object',
          description: '插入位置。省略 = 文件末尾;想插在光标处用 {"cursor":true}',
          additionalProperties: false,
          properties: {
            line: { type: 'number', description: '第几行(从 1 开始)' },
            character: { type: 'number', description: '这一行第几个字符(从 1 开始)' },
            cursor: { type: 'boolean', description: 'true = 插在用户光标处' },
          },
        },
      },
      required: ['file', 'text'],
    },
    async execute(args, exec) {
      const at = args.at?.cursor ? 'cursor' : args.at?.line ? { line: args.at.line, character: args.at.character ?? 1 } : 'end';
      const response = await call(exec, 'insert', { file: args.file, text: args.text, at });
      const result = response.result ?? {};

      // 新文件不擅自创建:扩展会把内容暂存,给一个 token,等人这边的调用方明确确认
      if (result.needConfirm) return { report: needConfirmReport(result.needConfirm, 'insert') };

      const where = result.at ? `第 ${result.at.line} 行` : '末尾';
      const created = result.created ? '(新建文件)' : '';
      const warning = result.warning ? `\n\n⚠ ${result.warning}` : '';
      const handoffReport = await handoff(exec);
      return { report: `◆ 写入 ${result.path}${created} · 从${where}起 ${result.lines} 行${warning}\n\n${handoffReport}` };
    },
  });

  const replace = editorTool({
    name: 'editor_replace',
    description:
      '替换文件里的一段(或整份)。行号从 1 开始,两端都含。目标文件必须在前台(先 editor_open)。**写完会自动停下来等人点继续** —— 不用再调 editor_wait。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: FILE_PROPERTY,
        text: { type: 'string', description: '替换成什么;留空字符串 = 删掉这一段。多行内容记得结尾带 \\n,否则会和下一行粘在一起' },
        from: { type: 'number', description: '要从第几行开始替换(从 1 开始)' },
        to: { type: 'number', description: '替换到第几行(含)' },
        character: { type: 'number', description: '起始行从第几个字符开始(从 1 开始),默认 1' },
      },
      required: ['file', 'text'],
    },
    async execute(args, exec) {
      // 到"下一行的开头" = 这一行(含换行)的结尾。写成同一行的 character:1 是零长度范围,
      // 那会变成纯插入 —— 换不掉任何东西。越界时扩展会自动夹到文档末尾。
      const toLine = args.to ?? args.from;
      const range =
        args.from === undefined
          ? undefined
          : {
              from: { line: args.from, character: args.character ?? 1 },
              to: { line: toLine + 1, character: 1 },
            };
      const response = await call(exec, 'replace', { file: args.file, text: args.text, range });
      const result = response.result ?? {};

      // 和 insert 一样:新文件先暂存,要一个明确的确认
      if (result.needConfirm) return { report: needConfirmReport(result.needConfirm, 'replace') };

      const warning = result.warning ? `\n\n⚠ ${result.warning}` : '';
      const handoffReport = await handoff(exec);
      return {
        report: `◆ 替换 ${result.path} · 第 ${result.from?.line}-${result.to?.line} 行(换掉 ${result.replacedLines} 行,写入 ${result.lines} 行)${warning}\n\n${handoffReport}`,
      };
    },
  });

  const point = editorTool({
    name: 'editor_point',
    description:
      '指给人看:高亮若干整行,每段可以在行尾挂一句话。**不改代码** —— 讲已有代码时用它,不要为了指一下就改文件。可以一次标好几段不连续的。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: FILE_PROPERTY,
        marks: {
          type: 'array',
          description: '要标的段,可以有好几段、彼此不连续',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              from: { type: 'number', description: '第一行(从 1 开始)' },
              to: { type: 'number', description: '最后一行(含);省略 = 只标 from 那一行' },
              say: { type: 'string', description: '挂在这一段首行行尾的一句话("为什么")' },
            },
            required: ['from'],
          },
        },
      },
      required: ['file', 'marks'],
    },
    async execute(args, exec) {
      const file = args.file;
      const marks = Array.isArray(args.marks) ? args.marks : [];
      if (marks.length === 0) return { report: '没给 marks,什么都没标。' };

      const ranges = marks.map((mark) => ({ fromLine: mark.from, toLine: mark.to ?? mark.from }));
      const highlighted = await call(exec, 'highlight', { file, ranges });
      const path = highlighted.result?.path ?? file ?? '当前文件';

      const notes = [];
      for (const mark of marks) {
        const say = String(mark.say ?? '').trim();
        if (!say) continue;
        const noted = await call(exec, 'annotate', { file, line: mark.from, text: say });
        notes.push(noted.result?.line ?? mark.from);
      }

      const span = marks.map((m) => (m.to && m.to !== m.from ? `${m.from}-${m.to}` : `${m.from}`)).join(', ');
      return {
        report: `◆ 指了 ${path} 第 ${span} 行${notes.length > 0 ? `,其中 ${notes.length} 处挂了注解` : ''}(没改任何代码)`,
      };
    },
  });

  const wait = editorTool({
    name: 'editor_wait',
    description:
      '交棒:停下来等用户点「继续」或「暂停」。**写操作(editor_insert / editor_replace / editor_confirm_create)已经自带交棒,不用再调这个**;它用于指完(editor_point)之后,或者只想等一会儿的时候。只被那两个按钮唤醒,打字和切文件都不算。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_args, exec) {
      // 和写操作内部用的是同一个交棒实现 —— 文案与语义只有一处
      return { report: await handoff(exec) };
    },
  });

  /**
   * 确认新建文件。**单独一个工具**,不是 insert 的参数 —— 因为它要走审批通道。
   *
   * 如果把它做成 editor_insert 的一个参数,模型在同一个调用里就能确认,
   * 审批形同虚设:它既是被审的人,又拿着钥匙。
   */
  const confirmCreate = editorTool({
    name: 'editor_confirm_create',
    description:
      '确认新建文件。editor_insert / editor_replace 返回 needConfirm 之后调它。**它会弹窗让用户批准**,批准后写入并**自动停下等人点继续**。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: FILE_PROPERTY,
        confirm: { type: 'string', description: 'needConfirm 里返回的 token' },
        op: {
          type: 'string',
          enum: ['insert', 'replace'],
          description: '当初是哪个操作暂存的内容,默认 insert',
        },
      },
      required: ['file', 'confirm'],
    },
    async execute(args, exec) {
      const op = args.op === 'replace' ? 'replace' : 'insert';
      const response = await call(exec, op, { file: args.file, confirm: args.confirm });
      const result = response.result ?? {};
      if (result.needConfirm) {
        return { report: `◆ 还是没建:token 可能过期了(${result.needConfirm.expiresIn} 秒有效)。重新发起写入再确认。` };
      }
      const handoffReport = await handoff(exec);
      return {
        report: `◆ 已新建并写入 ${result.path} · ${result.lines ?? 0} 行${result.warning ? `\n\n⚠ ${result.warning}` : ''}\n\n${handoffReport}`,
      };
    },
  });

  const selftest = editorTool({
    name: 'editor_selftest',
    description: '诊断:报告插件当前看到的绑定表、默认 token 和调用方的会话 id。只在排查连通性问题时用。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_args, exec) {
      const sessionId = exec?.agent?.id ?? null;
      return {
        report: JSON.stringify(
          {
            sessionId,
            boundToken: sessionId ? (tokenForSession(sessionId) === token ? '(默认)' : '(由绑定提供)') : null,
            bindings: [...bindings.bySession.entries()],
            defaultToken: token ? '已设置' : '(空)',
          },
          null,
          1,
        ),
      };
    },
  });

  return [ping, look, read, open, insert, replace, point, wait, confirmCreate, selftest];
}

// ── 唤醒(推送 → 新的一轮)──────────────────────────────────

/** 手搓一条用户消息:`createUserMessage` 的本质就是这四个字段 + 冻结。 */
function makeUserMessage(text) {
  const content = [{ type: 'text', text }];
  for (const block of content) Object.freeze(block);
  Object.freeze(content);
  const message = {
    id: randomUUID(),
    role: 'user',
    content,
    source: Object.freeze({ kind: 'user' }),
  };
  return Object.freeze(message);
}

/**
 * 用户从编辑器里"询问 agent"或点了「唤醒」,而 agent 没在等 —— 主动开一轮。
 *
 * 用 Agent.followup():它排一个普通跟进回合并唤醒驱动,这条消息成为那一回合唯一的
 * 用户消息。所以 DSH 那边看起来就是"用户发了一句话",和手动输入没有区别。
 */
function wakeAgent(ctx, event, bindings) {
  const agents = ctx.agents;

  /**
   * 目标会话:先按推送里的 `token` 查绑定表,查不到才退到"恰好一个活跃会话"。
   *
   * 为什么要 token:一个插件可能同时管着多块编辑器工作区。token 说明"这条问话
   * 来自哪个工作区",绑定表再把工作区映射到会话 —— 这样多开也不会串台。
   */
  const { byToken } = bindings;
  const sourceToken = typeof event?.token === 'string' ? event.token : '';
  const boundSessionId = sourceToken ? byToken.get(sourceToken) : undefined;

  let target;
  if (boundSessionId) {
    target = typeof agents?.get === 'function' ? agents.get(boundSessionId) : undefined;
    if (!target) {
      ctx.logger?.warn(
        `[code-tutor] token ${sourceToken} 绑定的会话 ${boundSessionId} 现在不活跃 —— 这条问话没送达`,
      );
      return;
    }
  } else {
    if (sourceToken) {
      ctx.logger?.warn(
        `[code-tutor] token ${sourceToken} 没有绑定任何会话(设置里的 bindings) —— 退到"唯一活跃会话"`,
      );
    }
    const roots = typeof agents?.roots === 'function' ? agents.roots() : [];
    if (roots.length !== 1) {
      ctx.logger?.warn(
        `[code-tutor] 无法确定该叫醒哪个会话(活跃 ${roots.length} 个)—— 建议在设置里给 token ${sourceToken || '(未知)'} 绑定会话`,
      );
      return;
    }
    target = roots[0];
  }

  const parts = ['(来自 VS Code 编辑器)'];
  if (event.event === 'ask') {
    const where = event.line ? `${event.file} 第 ${event.line} 行` : event.file ?? '编辑器';
    parts.push(`我在看 ${where}。`);
    const quote = String(event.quote ?? '').trim();
    if (quote) parts.push('```', quote.slice(0, 1200), '```');
    parts.push('', `问:${String(event.text ?? '').trim()}`);
    parts.push('', '（需要更多上下文就用 editor_read 自己读，别猜。）');
  } else {
    parts.push('我在编辑器里点了「继续」。接着讲。');
  }

  try {
    const agent = target;
    const message = makeUserMessage(parts.join('\n'));
    if (typeof agent.followup === 'function') agent.followup(message);
    else if (typeof agent.send === 'function') agent.send(message, 'next-turn', true);
    else throw new Error('这个 Agent 既没有 followup 也没有 send');
    ctx.logger?.info?.('[code-tutor] 用户从编辑器叫醒了一次');
  } catch (error) {
    ctx.logger?.warn(`[code-tutor] 唤醒失败:${error?.message ?? error}`);
  }
}

// ── 挂载 ────────────────────────────────────────────────────

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{port?: number, token?: string}} [config]
 */
export function apply(ctx, config) {
  const { port, token, bindings, discoveredFrom } = resolveConfig(config);
  const bridge = new Bridge({ port, token });

  if (discoveredFrom) {
    ctx.logger?.info?.(`[code-tutor] 会话 token 自动取自 ${discoveredFrom}`);
  }

  if (!token) {
    ctx.logger?.warn(
      '[code-tutor] 没有配置会话 token —— 每个请求都会被编辑器拒掉。' +
        '把工作区设置 tutorApi.conversationToken 的值填到插件配置、EDITOR_API_TOKEN,或 config.json 里',
    );
  }

  // 反方向:人在状态栏点了「询问 agent」或「唤醒」,而 agent 没在等。
  bridge.onEvent((event) => {
    if (event?.event === 'ask' || event?.event === 'confirm') wakeAgent(ctx, event, bindings);
  });

  // 唤醒要靠一条常连接;编辑器晚起来也能自己重连。
  ctx.effect(() => {
    let stopped = false;
    const tick = () => {
      if (!stopped) bridge.ensureConnected().catch(() => {});
    };
    tick();
    const timer = setInterval(tick, 15000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, 'dsh-agent-code-tutor.bridge-reconnect');

  // 新建文件要过审批:这个工具会走 DSH 的 approval 通道
  // (权限够就放行,不够就弹窗;没人可问时 fail-closed 拒绝)
  ctx.effect(
    () =>
      ctx.on('tools/pre-execute', async (exec, next) => {
        if (exec.name !== 'editor_confirm_create') return next();
        return {
          kind: 'ask',
          reason: 'agent 想在编辑器里新建文件',
          displayReason: {
            en: 'Allow the agent to create a new file in the editor?',
            'zh-CN': '允许 agent 在编辑器里新建这个文件吗?',
          },
        };
      }),
    'dsh-agent-code-tutor.approval',
  );

  // 随插件发一个 skill:它教模型"什么时候该指、什么时候该写"。
  // 挂 skill 而不是只靠系统提示,是因为 skill 能被模型按需加载 —— 触发词写在 description 里。
  ctx.effect(
    () =>
      ctx.skills.register({
        name: 'editor-tutor',
        description:
          '在编辑器里边写边讲。适用:"这个文件为什么这么改""这段帮我读一下""哪里是关键""指给我看""教我做 X""边写边讲"。' +
          '会让 agent 用 editor_point 在代码上标出来,而不是在对话框里复述代码。',
        whenToUse:
          '用户在看代码、学代码、想让 agent 指出问题或讲解某段代码时;或者要求 agent 一小步一小步往编辑器里写代码时。',
        source: 'bundled',
        content: SKILL_BODY,
      }),
    'dsh-agent-code-tutor.skill',
  );

  /** 这个会话该用哪个工作区的 token:查绑定表,查不到用插件默认的。 */
  const tokenForSession = (sessionId) => bindings.bySession.get(sessionId) ?? token;

  for (const tool of createTools(bridge, tokenForSession)) {
    ctx.effect(() => ctx.tools.register(tool), `dsh-agent-code-tutor.tool.${tool.name}`);
  }

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'tool:dsh-agent-code-tutor',
        order: 118,
        text: RULES,
      }),
    'dsh-agent-code-tutor.prompt',
  );

  // 插件卸载 / HMR 时别再攥着一条连接。
  ctx.effect(
    () => () => {
      bridge.close();
    },
    'dsh-agent-code-tutor.bridge',
  );
}
