# dsh-agent-code-tutor

```
https://github.com/Thomas-key/agent_code_tutor
```
vscode端对应插件。

把编辑器当成 agent 的**手和眼**。这边是 DSH 插件,另一头是
[agent_code_tutor](https://github.com/Thomas-key/agent_code_tutor) 那个 VS Code 扩展 ——
协议见 [API.md](https://github.com/Thomas-key/agent_code_tutor/blob/main/API.md)。

```
DSH(对话在这里)── editor_* 工具 ──▶ agent_code_tutor 扩展 ──▶ 编辑器
                ◀── 推送:用户问了 agent 一句 ──┘
```

## 安装

推成 GitHub 仓库之后,三种方式都行:

```
dsh plugin add github:Thomas-key/dsh-agent-code-tutor
dsh plugin add https://github.com/Thomas-key/dsh-agent-code-tutor
```

或者用 DSH 的插件管理面板,把仓库地址粘进去。

**装完能直接用**,不用先配置 —— 端口默认 `41890`,会话 token 会自己从
工作区里找(扫 cwd 及其直接子目录的 `.vscode/settings.json`,取
`tutorApi.conversationToken`;找到多个不同的值就不猜,报错让你填)。

前提是编辑器那边装了 [agent_code_tutor](https://github.com/Thomas-key/agent_code_tutor)
扩展。

## 工具

| 工具 | 干什么 |
|---|---|
| `editor_ping` | 连通性 + 支持哪些能力 |
| `editor_look` | 前台文件、光标、选区、未落盘、上次调用以来人做了什么 |
| `editor_read` | 读文件(内存 buffer,含未保存改动;默认 200 行,带总行数) |
| `editor_open` | 打开并聚焦 —— **写之前必须先做** |
| `editor_insert` | 插一段文本。**写完自动交棒**等人点继续 |
| `editor_replace` | 替换一段或整份。**写完自动交棒** |
| `editor_confirm_create` | 确认新建文件。**会弹窗问人**,批准后写入并自动交棒 |
| `editor_point` | 指:高亮若干段 + 行尾注解,**不改代码、不停** |
| `editor_wait` | 只想停下来时用(比如指完之后)。写操作已自带交棒,不用再调 |

**落盘(save)和清浮层(clear)没有开放给 agent** —— 存不存、擦不擦由人决定。

## 附带一个 skill

`skills/editor-tutor/SKILL.md` —— 插件加载时注册成 `editor-tutor`,模型会在合适的时候自己加载它。

它教的是**判断**,不是语法:

- 听到"这个文件为什么这么改""这段帮我读一下""哪里是关键"时 → 用 `editor_point` 指出来,
  **不是在对话框里复述代码**
- 说"教我写"时 → `editor_open` + `editor_insert` 一小段,工具自己会停下来
- 暂停 = 代码已被撤回,先问"哪里不对"

改这个文件不用动代码 —— 重启后生效。

## 文件

| 文件 | 职责 |
|---|---|
| `index.js` | 宿主半:九个工具、交棒、审批、skill、配置 |
| `client.js` | 客户端半:设置页里的表单 |
| `lib/bridge.js` | 到编辑器的 TCP 客户端(token、自环守卫、推送) |
| `skills/editor-tutor/SKILL.md` | 教模型"什么时候指、什么时候写"的 skill |
| `cordis.patch.yml` | 把插件行插进 profile |
| `locale/*.json` + `icon.svg` | 插件列表里显示的名字 / 描述 / 图标 |

## 实现要点(都是踩出来的)

1. **配置字段必须 `.volatile()`**
   DSH 的设置页只把标了 `volatile` 的字段当成可配置项(`dsh-settings` 的 `volatileForm`
   过滤)。没有这个标记,整条配置会被跳过,客户端永远拿到 `unavailable` ——
   表现出来就是"设置页说服务不可用"。参考 `agent-loop` 的
   `maxParallelToolCalls: z.number().default(10).volatile()`。

2. **设置页必须有客户端半**
   Host 导出 `Config` 只是注册了 schema,**不会自动生成页面**。左侧导航里那些页
   (费用 / 快照 / 状态文案 / 语音模式)全是插件自己的 `client.js` 注册进
   `settings.section` 槽渲染的。

3. **写类工具自带交棒**
   `editor_insert` / `editor_replace` / `editor_confirm_create` 在返回前就等人按按钮。
   不靠提示词约束模型 —— 让它没有"接着写"这个选项。

4. **新建文件走审批**
   `editor_insert` 遇到不存在的文件只返回 token;真正的创建由 `editor_confirm_create`
   完成,它被 `tools/pre-execute` 拦下来返回 `{kind:'ask'}`,走 DSH 的 approval 通道。

## 配置

**DSH 设置页里能直接改** —— 插件导出了 `Config` schema,设置页会给这个插件渲染一张表单:

| 设置 | 说明 |
|---|---|
| `port` | 扩展监听的端口,要和编辑器设置 `tutorApi.port` 一致 |
| `token` | 会话 token,要和 `tutorApi.conversationToken` 一致;**留空则自动从工作区里找** |
| `bindings` | **会话绑定表**:`会话id=token`,多条用分号分隔。收到哪个 token 的问话就送给对应会话 |

取值优先级(前面的赢):

1. DSH 设置页 / `cordis.patch.yml` 里的 `config`
2. 环境变量 `EDITOR_API_PORT` / `EDITOR_API_TOKEN`
3. 插件目录下的 `config.json`
4. 自动发现:扫 cwd 及其直接子目录的 `.vscode/settings.json` 取 `tutorApi.conversationToken`
5. 默认值:端口 `41890`,token 空(空的话每个请求都会被拒)

> 空字符串一律当作"没配",所以设置页留空不会盖住环境变量和自动发现。

## 多开会话:token ↔ 会话 的绑定

| | 标识的是 | 谁维护 |
|---|---|---|
| `token` | **一块编辑器工作区** —— 这份配置属于哪个编辑器窗口 | 编辑器侧的 `tutorApi.conversationToken` |
| `sessionId` | **一个 DSH 会话** | DSH 的会话 id |

一个插件可以同时管着多块编辑器、多个会话。用 `bindings` 把它们对上:

```
bindings = "a1b2=0f3e9c; c4d5=6075a344"
            ↑会话id ↑token    ↑会话id ↑token
```

之后:

- **编辑器 → agent**:推送里带着自己的 `token`,插件查表找到该送哪个会话 —— 多开不会串台
- **agent → 编辑器**:工具调用按**发起它的会话**去取绑定的 token,自动连到对的编辑器
- **查不到绑定**:退到"恰好一个活跃会话"的启发式;再不行就写日志说明没送达

> `sessionId` 是 DSH 的会话 id(会话 URL 里的那串)。绑定之后,只要那个会话还开着,
> 编辑器里问一句就能直达它 —— 不需要猜、也不会因为同时开着别的会话而丢消息。

## 设计

- **不 import 任何 `@deepseek-ai/*` 包**:以 `link:` 装进来的工作区插件,模块解析层
  只在 manifest 的 peerDependencies 里认识那个名字;一个 bare import 都不要,代价只是自己写
  JSON Schema 和输出契约。
- **交棒不设超时**:用户在读代码,等多久都不烧 token;设了超时反而会让 agent 在用户离开时
  自己往下讲。
- **唤醒只认唯一会话**:`ctx.agents.roots()` 必须恰好一个 —— 多个会话时不知道发给谁。
