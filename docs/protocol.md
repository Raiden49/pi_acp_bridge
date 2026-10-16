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

## 会话生命周期与文本流

- `session/new` 要求 `cwd` 为现有目录的绝对路径，返回独立随机 `sessionId`。使用 `SessionManager.create(cwd)` 创建 Pi JSONL 会话，再调用 `createAgentSession({ cwd, sessionManager })`，由 Pi 在该目录发现项目设置、上下文及工具路径。不调用 `process.chdir()`，不共享会话历史。模型与凭据遵循 Pi 的常规配置。
- `cwd` 提供上下文及相对路径隔离，**不是文件系统安全沙箱**：绝对路径、`..`、bash 及扩展仍可能访问其他目录。仅应对可信工作区使用。工作区扩展仍遵循 Pi 的资源加载与信任规则。
- 仅支持单工作区。额外目录及不支持的内容返回 `-32602`，不静默忽略。文本块与嵌入文本资源按顺序以换行拼接；非图片资源链接转为 Markdown 链接。图片处理见下文。未配置可用模型/凭据时，会话可以创建，但提示会失败。
- `session/prompt` 在调用 Pi 前订阅事件，将 `message_update` / `text_delta` 映射为 `session/update` 中的 `agent_message_chunk`，将 `thinking_delta` 单独映射为 `agent_thought_chunk`，均使用 `{ type: "text", text: delta }`。思考不混入回复正文，客户端可将其渲染为可折叠区块。文本、思考及工具通知共用有序发送队列，按序排空后才返回提示结果。
- 不同会话可以并发；同一会话已有活动提示时返回 `-32600`，不隐式排队。正常结束返回 `end_turn`，长度截断返回 `max_tokens`，取消返回 `cancelled`。Pi 推理错误返回不含原始提供商细节的 `-32603`。
- `session/cancel` 立即调用 Pi `abort()`，活动提示结算为 `cancelled`；即使 Pi 的提示 Promise 因中止而拒绝，也不返回推理错误。已发送的文本和思考片段不撤回，不清空 Pi 历史；取消后不再发送该提示的排队或新增片段。保留会话供后续提示使用，提示成功、失败或取消后均移除桥接订阅。
- `session/close` 从会话表删除会话、阻止后续通知、取消活动提示，等待扩展 `session_shutdown` 完成 MCP 清理后调用 `session.dispose()`。连接断开时释放所有会话；创建过程中断开连接时，创建完成后立即释放。未知或已关闭的会话在提示请求中返回 `-32602`；关闭不删除持久化历史，随后可通过 `session/load` 重新打开。

## 客户端 MCP

`session/new` 和 `session/load` 的 `mcpServers` 支持 stdio（`command`、`args`、`env`）与 Streamable HTTP（`type: "http"`、`url`、`headers`）。旧式 SSE 和 ACP 内嵌传输返回 `-32602`。服务名须由字母、数字、下划线、连字符构成；重复名称或 `-`/`_` 归一化后冲突会被拒绝。

客户端配置仅存在于当前会话的 Pi 官方 MCP 扩展中，不写 `mcp.json` 或会话索引，不启动 Pi 子进程。stdio 服务在会话工作区运行；客户端 env/headers 按字面值传入，不执行 Pi 配置的 `!command` 或 `${VAR}` 插值。HTTP 使用客户端提供的 headers，不自动复用 Pi 模型认证。客户端可指定本地进程与网络地址，因此只接受可信 IDE。Pi 的普通工具与用户扩展不受替换。

服务在 `session_start` 时异步连接，工具以 `mcp__<server>__<tool>` 直接提供给模型。工具发现、分页、动态工具列表、资源工具、调用与取消信号由官方 MCP 扩展处理，工具事件继续走现有 ACP `tool_call` / `tool_call_update` 映射。首个提示按 Pi 默认最多等待 direct 服务 10 秒；连接失败不等同于会话创建失败，失败的服务不会提供工具；Pi 的 `/mcp` 状态管理属于扩展 UI，当前桥接器尚未映射其通知面板，因此不把会话创建成功作为 MCP 连通证据。这里不增加 MCP OAuth 登录界面，也不默认加载用户/项目 `mcp.json` 中的其他服务。

关闭会话、ACP 输入断开或 CLI 收到 SIGTERM/SIGINT 时发出 `session_shutdown`，等待 MCP 连接释放再 dispose；stdio 进程由官方 transport 关闭 stdin 并终止，HTTP 会话发送 DELETE。取消提示仅取消当前请求，保留连接供后续提示使用。恢复会话重新采用客户端本次传入的配置。

## 图片、命令发现与持久化

### 图片

- ACP `{ type: "image", mimeType, data }` 的 base64 数据传入 Pi `prompt(text, { images })`，不会嵌入文本。`image` 块的 `data` 为空时，可用 `uri: "file:///absolute/path.png"` 指定本地文件；也支持带 `image/*` MIME 的 `resource_link`。不下载 HTTP 图片。base64 格式错误或本地文件不可读时返回 `-32602`。图片能力不意味着当前模型一定支持视觉。
- Pi 工具增量及最终结果的图片保留在 ACP 工具 `content` 中。最终图片 bytes 按 SHA-256 命名，保存至 `~/workspace/storage/media/pi-acp-bridge/`；聊天正文只发送 text 类型的 `agent_message_chunk`，包含 Markdown 绝对 `file:///` 链接及可复制的绝对路径。历史回放也采用同一转换，不再向助手正文发送图片或 `resource_link` 对象，避免 Air 将其显示成包含 Base64 的 JSON。此方式不保证客户端内嵌预览。模型输出的行内本地 Markdown 图片 `![名称](路径)` 也转换为普通 `file:///` 链接：绝对路径直接转换，相对路径按会话 cwd 解析，已有 file URI 保留；HTTP 等远程图片不改写。实时文本仅缓冲未完成的图片标记，普通文字继续流式发送；反引号代码片段/围栏中的示例保持原样，未完成的标记在回复结束时原样输出。历史中的助手文本也执行同一转换，不修改 JSONL 原文。测试可通过 `ServerOptions.artifactDir` 覆盖目录。文件不会自动删除；可能包含敏感信息，应由用户按资产生命周期管理。无法保存或发送时，提示返回 `-32603`，不会伪造成功链接。

### 命令发现

- 创建及加载会话时，发送 `available_commands_update`，包含实际加载的扩展命令、提示模板及 `/skill:name`。ACP `name` 不带开头的 `/`；同名时按扩展、模板、技能顺序去重。技能广告遵循 Pi 的 `enableSkillCommands` 设置。
- 使用 Pi 的资源加载器与合并设置，不自行扫描硬编码目录；因此包括 Pi 配置的包、用户及项目资源。未加载的资源不会被广告。终端专用的 `/settings`、`/login`、`/quit` 等命令无法由 SDK `prompt()` 执行，因此不广告。新建或重新加载会话后刷新列表，不额外实现终端 `/reload`。

### 索引与恢复

- 索引默认位于 Pi agent 目录的 `acp-sessions.json`（默认 `~/.pi/agent/`，遵循 `PI_CODING_AGENT_DIR`），格式为 `{ "<ACP sessionId>": { "cwd": "/workspace", "sessionFile": "/.../sessions/...jsonl" } }`。JSONL 使用 Pi 默认的会话目录分组。为让尚未开始对话的 ACP ID 也可恢复，创建时先写入 Pi 生成的会话头，再由 Pi 管理后续写入。
- 索引更新使用同目录临时文件和原子 rename，并用 `.lock` 目录串行化多个进程的读改写，防止丢失其他会话。文件权限为 `0600`；损坏索引拒绝覆盖并返回泛化错误。进程异常终止可能遗留锁，等待 5 秒仍未释放时失败；确认无桥接器写入后可手动删除该 `.lock` 目录。
- `session/load` 要求已索引的 ID 和与创建时完全相同的绝对 `cwd`；拒绝额外目录及本连接已经加载或正在加载的 ID；使用本次请求携带的 MCP 配置重新建立连接，不复用旧客户端的端口或凭据。读取索引对应 JSONL，经 Pi `SessionManager.open()` 恢复模型上下文，回放当前分支的用户/助手文本、图片、思考和工具调用结果，最后发送命令列表。工具图片也重新提供文件链接。历史回放不会重新执行工具或发起模型请求。
- 关闭或断线后索引和 JSONL 均保留。移走、删除或损坏 JSONL 后加载失败，不偷偷创建替代会话。索引只序列化映射写入，**不提供跨进程 JSONL 会话租约**：跨客户端恢复应先关闭原客户端，不支持多个进程同时编辑同一会话。

## 自主工具执行与文件变更

Pi 在桥接器进程内自主执行已启用工具，不额外请求 ACP 权限确认。工具权限与可访问路径遵循工作区配置，不构成安全沙箱。

- `tool_execution_start` 映射为 `tool_call`（`in_progress`）；增量结果映射为 `tool_call_update`（`in_progress`）；结束映射为 `completed` 或 `failed`。使用 Pi 的 `toolCallId` 关联，保留 `rawInput` / `rawOutput`，文本结果作为工具内容返回。
- 工具 `path` 相对会话 `cwd` 解析，支持绝对路径与 `~/`。ACP `locations.path` / `Diff.path` 按 SDK 契约使用绝对文件路径，而非 URI；导航位置的 `_meta["pi-acp-bridge/uri"]` 同时提供编码后的 `file:` URI。读取使用 `offset`（默认 1），修改结束使用首个变更行，坐标均为 1-based。
- 对 `edit` / `write`，在开始及结束事件的同步监听器中读取真实文件，不在异步发送队列中读取。内容发生变化时，在结束通知的 `content` 中加入 `{ type: "diff", path, oldText, newText }`；新文件的 `oldText` 为 `null`。无法读取快照时不伪造 Diff；失败但实际产生变更时仍报告真实变更。快照按提示及工具调用隔离，提示结束后释放；仅覆盖这两个命名工具，不追踪 bash 或嵌套脚本的任意文件变更。
- 已配置的 `ask_user_question` 工具开始执行时，将 `questions[].question` 与 `options[].label` / `description` 转为聊天正文中的编号 Markdown 列表，并标注多选。此处只提供展示映射，不注册问卷工具，也不实现工具等待、答案回传或 ACP 扩展 UI；这些能力仍由提供该工具的扩展负责。
- 取消及关闭继续抑制该提示后续的所有通知，包括工具结果；已经执行的文件改动不会自动回滚。

## 测试边界

`test/protocol-harness.ts` 用 `duplexPair()` 创建双向内存流，连接与 CLI 相同的 `startServer()`；测试仅收发带换行的 JSON-RPC，不查看 handler 或 Pi 的私有状态，不调用模型网络服务。

`test/bundle.test.ts` 构建压缩单文件产物，检查 shebang 与 10 MB 体积预算，并启动禁止加载外部模块的真实 Node 进程进行 stdio 握手；SIGTERM 后必须在超时内退出并结束会话中的 MCP 子进程。同时经 `session/new` 验证用户目录的 TypeScript 扩展能使用内嵌 TypeBox、注册命令与可用模型提供商。生产构建设置 `PI_BUNDLED_NODE=true`，确保 Pi 使用内嵌模块加载扩展，而非依赖原始 SDK 安装路径。CLI 同时注册 Pi 官方静态 OAuth loaders，避免认证阶段的变量动态导入在 bundle 旁查找不存在的模块；回归测试以临时假 OAuth 凭据执行 OpenAI 认证派生并验证结果，禁止网络访问。图片处理依赖的 Photon WASM 由构建适配器压缩内嵌；SDK 找不到独立 resize worker 时回退到进程内处理。回归测试还验证独立 bundle 能实际解码有效 PNG，避免将模块加载失败误判为图片过大。此测试不调用真实模型或 IDE。

`test/mcp.test.ts` 经过 ACP 与真实 Pi 会话调用本地 stdio / HTTP MCP 工具，验证 env/headers 字面值、工作目录、恢复时更新的客户端配置、关闭后的子进程退出及断线时 HTTP 会话释放；没有真实模型请求，HTTP 服务只监听随机回环端口，测试结束关闭。

`test/models.test.ts` 使用真实 Pi 会话，仅替换模型网络流，经 ACP 验证原生下拉框、切换后提示实际使用所选模型、其他会话不受影响，以及未认证模型不展示且不可选择、未知模型/配置项拒绝；恢复时的配置广告由持久化测试覆盖。内存协议测试结束时显式关闭双向流的两个写端，兼容 Node 22 的 half-open 行为。

`test/initialize.test.ts` 覆盖握手、版本协商、无文件回退、自定义模型、重新发现、配置错误、密钥不泄漏与未实现认证的明确拒绝。

`test/sessions.test.ts` 在会话工厂边界注入可控会话，经过 NDJSON 验证并发路由、文本与思考流分离及顺序、流通知先于提示完成、同会话并发拒绝、取消时调用 abort、取消后的片段抑制与会话复用（包括 Pi 中止时拒绝的情况）、关闭、断线、订阅释放及失败后重试。

`test/workspace-isolation.test.ts` 使用真实 Pi `AgentSession`、项目资源发现及 `read` 工具，仅替换模型流为确定性的内存响应。经过 ACP 并发请求验证工作区指令、相对文件读取和对话内容隔离，不请求真实模型、不使用个人凭据。

`test/tools.test.ts` 使用真实 Pi 工具与确定性模型流，经 ACP 验证自主读取生命周期、导航位置、编辑及覆盖写入前后内容、新文件 Diff、失败编辑和问卷 Markdown 展示，无真实模型请求。

`test/image-links.test.ts` 在整段及逐字符输入下验证本地图片链接转换、路径编码、远程链接/代码保留及普通文本即时输出。`test/multimodal.test.ts` 经 NDJSON 验证内嵌和文件链接图片传给 Pi、工具原生图片、正文 Markdown 绝对文件链接及落盘文件 bytes。`test/commands.test.ts` 使用真实 Pi 资源加载器验证模板、扩展、技能发现及禁用技能设置。`test/persistence.test.ts` 使用真实 Pi JSONL 和 AgentSession 验证索引、跨连接加载、工作区匹配、历史与工具图片回放。`test/session-index.test.ts` 验证独立索引写入者并发时不丢映射，损坏索引不被覆盖。所有测试资产位于 `.scratch/`，不写个人 Pi 配置。

## 参考

- [ACP 初始化](https://agentclientprotocol.com/protocol/initialization)
- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
