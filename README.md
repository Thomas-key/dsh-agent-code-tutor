# dsh-agent-code-tutor

```
https://github.com/Thomas-key/agent_code_tutor
```
vscode端对应插件。

把编辑器当成 agent 的**手和眼**。这边是 DSH 插件,另一头是
[`agent_code_tutor`](../agent_code_tutor/) 那个 VS Code 扩展 —— 协议见
[`agent_code_tutor/API.md`](../agent_code_tutor/API.md)。

```
DSH(对话在这里)── editor_* 工具 ──▶ agent_code_tutor 扩展 ──▶ 编辑器
                ◀── 推送:用户问了 agent 一句 ──┘
```

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

## 配置

端口和会话 token 必须和扩展那边一致,否则连不上。取值顺序(前面的赢):

1. `cordis.patch.yml` 里该条目的 `config: { port, token }`
2. 环境变量 `EDITOR_API_PORT` / `EDITOR_API_TOKEN`
3. 插件目录下的 `config.json`
4. 默认端口 `41890`,token 空(空的话每个请求都会被拒)

```json
// config.json(不提交,已 gitignore)
{ "port": 41890, "token": "把工作区设置 tutorApi.conversationToken 抄过来" }
```

token 在编辑器的**工作区设置** `tutorApi.conversationToken` 里(扩展首次激活自动生成)。

**端口被占用怎么办**:改扩展的 `tutorApi.port`,再改这边的 `port` —— 两边一致。

## 设计

- **不 import 任何 `@deepseek-ai/*` 包**:以 `link:` 装进来的工作区插件,模块解析层
  只在 manifest 的 peerDependencies 里认识那个名字;一个 bare import 都不要,代价只是自己写
  JSON Schema 和输出契约。
- **交棒不设超时**:用户在读代码,等多久都不烧 token;设了超时反而会让 agent 在用户离开时
  自己往下讲。
- **唤醒只认唯一会话**:`ctx.agents.roots()` 必须恰好一个 —— 多个会话时不知道发给谁。
