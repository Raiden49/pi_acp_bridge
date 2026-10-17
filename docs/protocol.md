# ACP 初始化与会话协议

## 当前范围

支持 ACP v1 初始化、模型发现、进程内多会话、图片输入输出、命令发现及持久化会话恢复。`authenticate` 仍返回 JSON-RPC `-32601`，登录流程留待后续实现。会话模型选择使用标准 `configOptions`。取消通知不产生响应。没有启动 Pi 子进程。

`initialize` 返回：

- SDK 的 `PROTOCOL_VERSION`：收到不同版本时返回本服务支持的版本，由客户端决定是否继续。
- `agentInfo`：`pi-acp-bridge` 及来自 `package.json` 的版本。
- `agentCapabilities.loadSession: true`：支持从 Pi JSONL 恢复已索引的会话。
- `agentCapabilities.promptCapabilities: { image: true, embeddedContext: true }`：支持图片和嵌入文本资源；不支持的内容仍明确拒绝。
- `agentCapabilities.mcpCapabilities: { http: true }`：支持 stdio 与 Streamable HTTP MCP，不广告旧式 SSE 或 ACP 内嵌 MCP。
- `agentCapabilities.sessionCapabilities.close: {}`：支持 `session/close`。
- `authMethods: []`：本阶段不提供 ACP 登录方法，不表示所有模型均已认证。
- `_meta["pi-acp-bridge/models"]`：模型目录扩展。

## 模型目录扩展

标准 ACP `initialize` **没有模型列表字段**。为满足 #2 的初始化发现需求，本服务使用合法的 `_meta` 扩展：

```json
{
  "_meta": {
    "pi-acp-bridge/models": [
      { "modelId": "enterprise/custom-model", "name": "Company model" }
    ]
  }
}
```

模型 ID 为 `provider/id`，保留原始模型 ID 中的斜杠。只输出 ID 与显示名，不输出 endpoint、headers 或凭据。该扩展本身**不会填充 IDE 的标准模型下拉框**；原生模型选择由下述会话配置接口提供。

每次初始化调用 Pi 官方 `ModelRuntime`，读取 Pi agent 目录的 `models.json`（默认 `~/.pi/agent/models.json`，遵循 Pi 的 `PI_CODING_AGENT_DIR` 环境变量）。返回 Pi 内置聊天模型目录与配置覆盖/新增的聊天模型，不包含图片生成或分类模型。文件不存在时使用内置目录。目录不按凭据过滤，因此“已发现”不等于“可立即调用”。发现流程禁用创建时刷新，不执行远程目录请求、认证检查或密钥命令，不写入凭据或缓存。

配置无效时返回 `-32603` / `Invalid Pi model configuration`。不转发 Pi 原始校验错误，以免泄漏配置内容；修正文件后可重试初始化。

## 原生会话模型选择

`session/new` 与 `session/load` 返回 `configOptions`：`id: "model"`、`name: "Model"`、`category: "model"`、`type: "select"`。`currentValue` 为当前模型的 `provider/id`，`options` 来自该 Pi 会话自己的 `modelRuntime.getAvailableSnapshot()`，与 Pi 模型选择器使用同一可用性快照，每项使用 `{ value: "provider/id", name: "模型名 (provider)" }`。只显示 Pi 判定已配置认证的可用模型，不输出任何凭据；会话无当前模型、当前模型已不可用或未提供模型接口时返回空列表，不将未认证的历史模型重新加入选项。恢复会话遇到这种情况时，应先补齐 Pi 认证，再重连或新建会话。

客户端发送 `session/set_config_option`，参数为 `{ sessionId, configId: "model", value: "provider/id" }`。桥接器调用 Pi `session.setModel()`，成功返回更新后的完整 `configOptions`。切换只影响指定会话，保留对话历史，由 Pi 记录模型变更供恢复，不修改全局默认模型。不支持旧的非标准 `session/set_model`。

未知或不在可用快照中的模型、未知配置项、非字符串值或未知会话返回 `-32602`；提示进行中或正在切换模型时返回 `-32600`，不隐式取消或排队。切换过程也拒绝新提示。凭据等 Pi 切换错误统一返回不含原始错误细节的 `-32603`。快照反映 Pi 的认证配置，不代表远端服务保证接受调用；凭据失效仍可能导致切换或推理失败。初始化 `_meta` 中的完整目录不影响此过滤。

### Thinking 配置

reasoning 模型同时提供 `id: "thinking"`、`category: "thought_level"` 的 select 配置，档位直接取 Pi `getAvailableThinkingLevels()`。通过 `session/set_config_option` 设置 `configId: "thinking"`，作用于下一次推理；不支持的档位返回 `-32602`。切换到非 reasoning 模型后不再提供此项。调用 `setThinkingLevel(level, { persist: false })`，不修改全局默认配置；会话历史仍由 Pi 管理。没有新增斜杠命令。

## 原生交互表单

初始化检查 `clientCapabilities.elicitation.form`，只对声明支持的客户端发送标准 `elicitation/create`（`mode: "form"`）。表单由 IDE 渲染，不使用 Markdown 编号回答，也不借用权限确认弹窗。

- 不注册任何问答工具，也不按工具名或插件识别问题。通用地将 Pi `ctx.ui.select/confirm/input/editor` 转换为当前 session 的 ACP 表单。
- select 使用 string enum；input/editor 使用 string，允许用户提交空字符串，editor 携带原文默认值；confirm 使用 boolean，取消映射为 false。
- Pi SDK 的这些基础接口没有结构化多选接口。普通 input 保持输入框语义，不解析提示文案、编号或占位符来猜测复选框。问题组织、多个问题的顺序和答案解释由调用方负责。自定义 TUI 组件仍不支持。
- 用户提交后答案直接返回原工具/扩展，原 ACP prompt 继续执行；无需另发消息。取消或拒绝返回取消结果，绝不默认为批准。
- 停止提示、关闭会话或断线会取消等待；即使客户端未响应取消通知，也能在本地结束等待，迟到的答案不再生效。待答表单不跨断线持久化。
- 客户端未声明表单能力、请求失败或答案不符合表单契约时明确失败，不降级为文字命令。不新增 `/answer` 等指令，也不替换用户已有的同类工具。
- 表单只服务活动提示中的交互；不支持会话创建阶段阻塞式提问。第三方工具若只实现自定义 TUI，不能因此自动获得表单支持。

## 会话生命周期与文本流

- `session/new` 要求 `cwd` 为现有目录的绝对路径，返回独立随机 `sessionId`。使用 `SessionManager.create(cwd)` 创建 Pi JSONL 会话，再调用 `createAgentSession({ cwd, sessionManager })`，由 Pi 在该目录发现项目设置、上下文及工具路径。不调用 `process.chdir()`，不共享会话历史。模型与凭据遵循 Pi 的常规配置。
- `cwd` 提供上下文及相对路径隔离，**不是文件系统安全沙箱**：绝对路径、`..`、bash 及扩展仍可能访问其他目录。仅应对可信工作区使用。工作区扩展仍遵循 Pi 的资源加载与信任规则。
- 仅支持单工作区。额外目录及不支持的内容返回 `-32602`，不静默忽略。文本块与嵌入文本资源按顺序以换行拼接；非图片资源链接转为 Markdown 链接。图片处理见下文。未配置可用模型/凭据时，会话可以创建，但提示会失败。
- `session/prompt` 在调用 Pi 前订阅事件，将 `message_update` / `text_delta` 映射为 `session/update` 中的 `agent_message_chunk`，将 `thinking_delta` 单独映射为 `agent_thought_chunk`，均使用 `{ type: "text", text: delta }`。思考不混入回复正文，客户端可将其渲染为可折叠区块。文本、思考及工具通知共用有序发送队列，按序排空后才返回提示结果。
- 不同会话可以并发；同一会话已有活动提示时返回 `-32600`，不隐式排队。正常结束返回 `end_turn`，长度截断返回 `max_tokens`，取消返回 `cancelled`。Pi 推理错误返回不含原始提供商细节的 `-32603`。
- `session/cancel` 立即调用 Pi `abort()`，活动提示结算为 `cancelled`；即使 Pi 的提示 Promise 因中止而拒绝，也不返回推理错误。已发送的文本和思考片段不撤回，不清空 Pi 历史；取消后不再发送该提示的排队或新增片段。保留会话供后续提示使用，提示成功、失败或取消后均移除提示级订阅；标题订阅持续到会话关闭。
- `session/close` 从会话表删除会话、阻止后续通知、取消活动提示，等待扩展 `session_shutdown` 完成 MCP 清理后调用 `session.dispose()`。连接断开时释放所有会话；创建过程中断开连接时，创建完成后立即释放。未知或已关闭的会话在提示请求中返回 `-32602`；关闭不删除持久化历史，随后可通过 `session/load` 重新打开。

## 客户端 MCP

`session/new` 和 `session/load` 的 `mcpServers` 支持 stdio（`command`、`args`、`env`）与 Streamable HTTP（`type: "http"`、`url`、`headers`）。旧式 SSE 和 ACP 内嵌传输返回 `-32602`。服务名须由字母、数字、下划线、连字符构成；重复名称或 `-`/`_` 归一化后冲突会被拒绝。

客户端配置仅存在于当前会话的 Pi 官方 MCP 扩展中，不写 `mcp.json` 或会话索引，不启动 Pi 子进程。stdio 服务在会话工作区运行；客户端 env/headers 按字面值传入，不执行 Pi 配置的 `!command` 或 `${VAR}` 插值。HTTP 使用客户端提供的 headers，不自动复用 Pi 模型认证。客户端可指定本地进程与网络地址，因此只接受可信 IDE。Pi 的普通工具与用户扩展不受替换。

服务在 `session_start` 时异步连接，工具以 `mcp__<server>__<tool>` 直接提供给模型。工具发现、分页、动态工具列表、资源工具、调用与取消信号由官方 MCP 扩展处理，工具事件继续走现有 ACP `tool_call` / `tool_call_update` 映射。首个提示按 Pi 默认最多等待 direct 服务 10 秒；连接失败不等同于会话创建失败，失败的服务不会提供工具；扩展 `ctx.ui.notify()` 已映射为文字反馈，选择器可走上述原生表单，但自定义终端面板仍不支持，因此不把会话创建成功或菜单出现 `/mcp` 作为 MCP 连通证据。这里不增加 MCP OAuth 登录界面，也不默认加载用户/项目 `mcp.json` 中的其他服务。

关闭会话、ACP 输入断开或 CLI 收到 SIGTERM/SIGINT 时发出 `session_shutdown`，等待 MCP 连接释放再 dispose；stdio 进程由官方 transport 关闭 stdin 并终止，HTTP 会话发送 DELETE。取消提示仅取消当前请求，保留连接供后续提示使用。恢复会话重新采用客户端本次传入的配置。

## 图片、命令发现与持久化

### 图片

- ACP `{ type: "image", mimeType, data }` 的 base64 数据传入 Pi `prompt(text, { images })`，不会嵌入文本。`image` 块的 `data` 为空时，可用 `uri: "file:///absolute/path.png"` 指定本地文件；也支持带 `image/*` MIME 的 `resource_link`。不下载 HTTP 图片。base64 格式错误或本地文件不可读时返回 `-32602`。图片能力不意味着当前模型一定支持视觉。
- Pi 工具增量及最终结果的图片保留在 ACP 工具 `content` 中。最终图片 bytes 按 SHA-256 命名，保存至 `~/workspace/storage/media/pi-acp-bridge/`；最终工具结果同时附加 Markdown 绝对 `file:///` 链接、可复制路径和 ACP `locations` 文件导航，不再为同一工具图片额外发送助手正文。原生工具图片仍保留，供有预览能力的客户端渲染。历史回放采用相同工具结果转换；若助手历史本身包含图片，则以 text 文件链接兜底，不向助手正文发送图片或 `resource_link` 对象，避免 Air 将其显示成包含 Base64 的 JSON。此方式不保证客户端内嵌预览。模型输出的行内本地 Markdown 图片 `![名称](路径)` 也转换为普通 `file:///` 链接：绝对路径直接转换，相对路径按会话 cwd 解析，已有 file URI 保留；HTTP 等远程图片不改写。实时文本仅缓冲未完成的图片标记，普通文字继续流式发送；反引号代码片段/围栏中的示例保持原样，未完成的标记在回复结束时原样输出。历史中的助手文本也执行同一转换，不修改 JSONL 原文。测试可通过 `ServerOptions.artifactDir` 覆盖目录。文件不会自动删除；可能包含敏感信息，应由用户按资产生命周期管理。无法保存或发送时，提示返回 `-32603`，不会伪造成功链接。

### 命令发现

- 创建及加载会话时，发送 `available_commands_update`，包含 `/session`、`/reload`、`/compact` 及 Pi 原有 `/name` 的兼容适配，以及实际加载的扩展命令、提示模板和 `/skill:name`。ACP `name` 不带开头的 `/`；同名时按桥接内置、扩展、模板、技能顺序去重。技能广告遵循 Pi 的 `enableSkillCommands` 设置。
- `/session`：直接显示 ACP/Pi 会话 ID、历史文件、工作区、模型、消息和用量统计，以及 Pi 可提供的当前上下文占用。累计 token 不等于上下文大小；压缩后尚无新回复时，占用可能不可估算。不调用模型。
- `/reload`：调用 Pi `reload()`，重新加载设置、扩展、技能、模板，保留当前聊天上下文；重新发送命令列表和 `config_option_update`。扩展收到 shutdown/start 生命周期，客户端 MCP 使用当前会话原有配置重连。不重新读入其他进程写入的聊天记录，也不等于升级 bridge 二进制。桥接器本身不请求模型，但用户扩展的重载钩子仍由扩展控制。
- `/compact [摘要要求]`：调用 Pi `compact()`，使用当前模型及用户的压缩设置；通常会产生模型费用。当前没有可压缩历史时给出文字说明，不误报认证失败。手动和自动压缩的开始、完成、取消，以及自动重试等待均以文本通知展示，不显示原始提供商错误详情。摘要保存在 Pi JSONL，不改全局压缩设置。
- `/name [标题]`：兼容 Pi 终端已有命令；无参数查看标题，带参数调用 Pi `setSessionName()`，保留 SDK 的标题规范化和持久化行为，不请求模型。
- 四个命令只接受直接输入的文字，不接受附件；`/session` 和 `/reload` 不接受额外参数，误用返回 `-32602`。嵌入文档的内容不会被当作桥接内置命令。活动提示、压缩、重载期间拒绝同会话并发操作。取消压缩使用 Pi `abort()`；重载不能中途回滚，取消只抑制后续展示，关闭会话会等重载收尾后释放新资源。
- 扩展绑定统一由协议会话生命周期负责。`ctx.ui.notify()` 转为文字，并移除终端 ANSI 控制码；在进程内初始化无 watcher 的主题，避免扩展读取主题时报未初始化。`select`、`confirm`、`input`、`editor` 接入上述原生表单，不伪造答案；终端 `custom` 仍提示改用 Pi CLI。状态栏、widget、编辑器、快捷键和自定义 TUI 没有完整 ACP 映射；菜单可见仍不代表每个第三方命令都可运行。
- 使用 Pi 的资源加载器与合并设置，不自行扫描硬编码目录；因此包括 Pi 配置的包、用户及项目资源。未加载的资源不会被广告。终端专用的 `/settings`、`/login`、`/quit` 及会话切换/树选择命令尚未适配，不广告。

### 标题同步

创建、加载会话时发送已有标题；持续监听 Pi `session_info_changed` 并发送标准 `session_info_update`，包括没有活动提示时的更名。标题由 Pi 写入 JSONL，恢复后继续广告。现有 `/session` 报告也显示标题和 Thinking 档位。提供 Pi 已有 `/name` 的兼容支持，不另造改名语法，不调用模型生成标题，也没有实现 IDE 原生改名动作反向写回 Pi。

### 索引与恢复

- 索引默认位于 Pi agent 目录的 `acp-sessions.json`（默认 `~/.pi/agent/`，遵循 `PI_CODING_AGENT_DIR`），格式为 `{ "<ACP sessionId>": { "cwd": "/workspace", "sessionFile": "/.../sessions/...jsonl" } }`。JSONL 使用 Pi 默认的会话目录分组。为让尚未开始对话的 ACP ID 也可恢复，创建时先写入 Pi 生成的会话头，再由 Pi 管理后续写入。
- 索引更新使用同目录临时文件和原子 rename，并用 `.lock` 目录串行化多个进程的读改写，防止丢失其他会话。文件权限为 `0600`；损坏索引拒绝覆盖并返回泛化错误。进程异常终止可能遗留锁，等待 5 秒仍未释放时失败；确认无桥接器写入后可手动删除该 `.lock` 目录。
- `session/load` 要求已索引的 ID 和与创建时完全相同的绝对 `cwd`；拒绝额外目录及本连接已经加载或正在加载的 ID；使用本次请求携带的 MCP 配置重新建立连接，不复用旧客户端的端口或凭据。读取索引对应 JSONL，经 Pi `SessionManager.open()` 恢复模型上下文，从 `SessionManager.getBranch()` 回放当前分支的完整用户/助手文本、图片、思考和工具调用结果，最后发送命令列表。不会将压缩后的模型上下文误当作完整聊天历史：早期消息仍能恢复显示，模型继续使用 Pi 的压缩上下文。工具图片也重新提供文件链接。历史回放不会重新执行工具或发起模型请求。
- 关闭或断线后索引和 JSONL 均保留。移走、删除或损坏 JSONL 后加载失败，不偷偷创建替代会话。索引只序列化映射写入，**不提供跨进程 JSONL 会话租约**：跨客户端恢复应先关闭原客户端，不支持多个进程同时编辑同一会话。

## 自主工具执行与文件变更

Pi 在桥接器进程内自主执行已启用工具，不额外请求 ACP 权限确认。工具权限与可访问路径遵循工作区配置，不构成安全沙箱。

- `tool_execution_start` 映射为 `tool_call`（`in_progress`）；增量结果映射为 `tool_call_update`（`in_progress`）；结束映射为 `completed` 或 `failed`。使用 Pi 的 `toolCallId` 关联，保留 `rawInput` / `rawOutput`，文本结果作为工具内容返回。
- 工具 `path` 相对会话 `cwd` 解析，支持绝对路径与 `~/`。ACP `locations.path` / `Diff.path` 按 SDK 契约使用绝对文件路径，而非 URI；导航位置的 `_meta["pi-acp-bridge/uri"]` 同时提供编码后的 `file:` URI。读取使用 `offset`（默认 1），修改结束使用首个变更行，坐标均为 1-based。
- 对 `edit` / `write`，在开始及结束事件的同步监听器中读取真实文件，不在异步发送队列中读取。内容发生变化时，在结束通知的 `content` 中加入 `{ type: "diff", path, oldText, newText }`；新文件的 `oldText` 为 `null`。无法读取快照时不伪造 Diff；失败但实际产生变更时仍报告真实变更。快照按提示及工具调用隔离，提示结束后释放；仅覆盖这两个命名工具，不追踪 bash 或嵌套脚本的任意文件变更。
- 所有问答工具沿用普通工具事件通道。移除旧的按 `ask_user_question` 名称生成 Markdown 问卷的特判，避免与通用原生表单重复展示；不替换第三方工具的定义和返回结果。
- 取消及关闭继续抑制该提示后续的所有通知，包括工具结果；已经执行的文件改动不会自动回滚。

## 测试边界

`test/protocol-harness.ts` 用 `duplexPair()` 创建双向内存流，连接与 CLI 相同的 `startServer()`；测试仅收发带换行的 JSON-RPC，不查看 handler 或 Pi 的私有状态，不调用模型网络服务。

`test/bundle.test.ts` 构建压缩单文件产物，检查 shebang 与 10 MB 体积预算，并启动禁止加载外部模块的真实 Node 进程进行 stdio 握手；SIGTERM 后必须在超时内退出并结束会话中的 MCP 子进程。同时经 `session/new` 验证用户目录的 TypeScript 扩展能使用内嵌 TypeBox、注册命令与可用模型提供商。生产构建设置 `PI_BUNDLED_NODE=true`，确保 Pi 使用内嵌模块加载扩展，而非依赖原始 SDK 安装路径。CLI 同时注册 Pi 官方静态 OAuth loaders，避免认证阶段的变量动态导入在 bundle 旁查找不存在的模块；回归测试以临时假 OAuth 凭据执行 OpenAI 认证派生并验证结果，禁止网络访问。图片处理依赖的 Photon WASM 由构建适配器压缩内嵌；SDK 找不到独立 resize worker 时回退到进程内处理。回归测试还验证独立 bundle 能实际解码有效 PNG，避免将模块加载失败误判为图片过大。此测试不调用真实模型或 IDE。

`test/mcp.test.ts` 经过 ACP 与真实 Pi 会话调用本地 stdio / HTTP MCP 工具，验证 env/headers 字面值、工作目录、恢复时更新的客户端配置、关闭后的子进程退出及断线时 HTTP 会话释放；没有真实模型请求，HTTP 服务只监听随机回环端口，测试结束关闭。

`test/models.test.ts` 使用真实 Pi 会话，仅替换模型网络流，经 ACP 验证原生下拉框、切换后提示实际使用所选模型、其他会话不受影响，以及未认证模型不展示且不可选择、未知模型/配置项拒绝；恢复时的配置广告由持久化测试覆盖。内存协议测试结束时显式关闭双向流的两个写端，兼容 Node 22 的 half-open 行为。

`test/questions.test.ts` 经真实 Pi 工具与双向 ACP 请求验证通用输入（含空字符串）、编辑原文、单选、确认/拒绝、取消、停止/关闭时结束等待，以及未声明表单能力时明确失败；不使用新增斜杠命令。独立 bundle 同样验证原生表单回传、Thinking 设置和标题通知。

`test/initialize.test.ts` 覆盖握手、版本协商、无文件回退、自定义模型、重新发现、配置错误、密钥不泄漏与未实现认证的明确拒绝。

`test/sessions.test.ts` 在会话工厂边界注入可控会话，经过 NDJSON 验证并发路由、文本与思考流分离及顺序、流通知先于提示完成、同会话并发拒绝、取消时调用 abort、取消后的片段抑制与会话复用（包括 Pi 中止时拒绝的情况）、关闭、断线、订阅释放及失败后重试。

`test/workspace-isolation.test.ts` 使用真实 Pi `AgentSession`、项目资源发现及 `read` 工具，仅替换模型流为确定性的内存响应。经过 ACP 并发请求验证工作区指令、相对文件读取和对话内容隔离，不请求真实模型、不使用个人凭据。

`test/tools.test.ts` 使用真实 Pi 工具与确定性模型流，经 ACP 验证自主读取生命周期、导航位置、编辑及覆盖写入前后内容、新文件 Diff、失败编辑以及问答工具不重复生成助手问卷，无真实模型请求。

`test/context.test.ts` 使用真实 Pi 会话和 JSONL，仅替换模型网络流；覆盖长历史手动压缩、自定义摘要要求、压缩后继续对话及完整历史恢复、取消压缩与 busy 保护、空历史、上下文超限后自动压缩并重试。假模型仅证明控制流程与持久化，不证明真实模型的摘要质量。`test/commands.test.ts` 另外验证内置命令不误发给模型、重载后的命令刷新、扩展通知/原生确认表单，以及重载中关闭时的资源清理；MCP 和 bundle 回归覆盖重载重连及旧子进程退出。

`test/image-links.test.ts` 在整段及逐字符输入下验证本地图片链接转换、路径编码、远程链接/代码保留及普通文本即时输出。`test/multimodal.test.ts` 经 NDJSON 验证内嵌和文件链接图片传给 Pi、工具原生图片、工具内文件链接/导航、模型正文链接转换及落盘文件 bytes。`test/commands.test.ts` 使用真实 Pi 资源加载器验证模板、扩展、技能发现及禁用技能设置。`test/persistence.test.ts` 使用真实 Pi JSONL 和 AgentSession 验证索引、跨连接加载、工作区匹配、历史与工具图片回放。`test/session-index.test.ts` 验证独立索引写入者并发时不丢映射，损坏索引不被覆盖。所有测试资产位于 `.scratch/`，不写个人 Pi 配置。

## 参考

- [ACP 初始化](https://agentclientprotocol.com/protocol/initialization)
- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
