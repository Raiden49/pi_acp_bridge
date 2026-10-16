# ACP 初始化与会话协议

## 当前范围

支持 ACP v1 初始化、模型发现、进程内多会话及文本流。`authenticate` 仍返回 JSON-RPC `-32601`，模型切换与登录流程留待后续实现。取消通知不产生响应。没有启动 Pi 子进程。

`initialize` 返回：

- SDK 的 `PROTOCOL_VERSION`：收到不同版本时返回本服务支持的版本，由客户端决定是否继续。
- `agentInfo`：`pi-acp-bridge` 及来自 `package.json` 的版本。
- `agentCapabilities.loadSession: false`：内存会话不支持加载历史。
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

模型 ID 为 `provider/id`，保留原始模型 ID 中的斜杠。只输出 ID 与显示名，不输出 endpoint、headers 或凭据。该扩展**不会自动填充 IDE 的标准模型下拉框**；原生模型选择需要后续会话配置接口接入。

每次初始化调用 Pi 官方 `ModelRuntime`，读取 Pi agent 目录的 `models.json`（默认 `~/.pi/agent/models.json`，遵循 Pi 的 `PI_CODING_AGENT_DIR` 环境变量）。返回 Pi 内置聊天模型目录与配置覆盖/新增的聊天模型，不包含图片生成或分类模型。文件不存在时使用内置目录。目录不按凭据过滤，因此“已发现”不等于“可立即调用”。发现流程禁用创建时刷新，不执行远程目录请求、认证检查或密钥命令，不写入凭据或缓存。

配置无效时返回 `-32603` / `Invalid Pi model configuration`。不转发 Pi 原始校验错误，以免泄漏配置内容；修正文件后可重试初始化。

## 会话生命周期与文本流

- `session/new` 要求 `cwd` 为现有目录的绝对路径，返回独立随机 `sessionId`。每次调用 `createAgentSession({ cwd, sessionManager: SessionManager.inMemory(cwd) })`，由 Pi 在该目录发现项目设置、上下文及工具路径。不调用 `process.chdir()`，不共享会话历史。模型与凭据遵循 Pi 的常规配置。
- `cwd` 提供上下文及相对路径隔离，**不是文件系统安全沙箱**：绝对路径、`..`、bash 及扩展仍可能访问其他目录。仅应对可信工作区使用。工作区扩展仍遵循 Pi 的资源加载与信任规则。
- 仅支持单工作区、文本提示。非空 `mcpServers`、额外目录及非文本内容返回 `-32602`，不静默忽略。文本块按顺序以换行拼接。未配置可用模型/凭据时，会话可以创建，但提示会失败。
- `session/prompt` 在调用 Pi 前订阅事件，将 `message_update` / `text_delta` 映射为 `session/update` 中的 `agent_message_chunk`，将 `thinking_delta` 单独映射为 `agent_thought_chunk`，均使用 `{ type: "text", text: delta }`。思考不混入回复正文，客户端可将其渲染为可折叠区块。文本、思考及工具通知共用有序发送队列，按序排空后才返回提示结果。
- 不同会话可以并发；同一会话已有活动提示时返回 `-32600`，不隐式排队。正常结束返回 `end_turn`，长度截断返回 `max_tokens`，取消返回 `cancelled`。Pi 推理错误返回不含原始提供商细节的 `-32603`。
- `session/cancel` 立即调用 Pi `abort()`，活动提示结算为 `cancelled`；即使 Pi 的提示 Promise 因中止而拒绝，也不返回推理错误。已发送的文本和思考片段不撤回，不清空 Pi 历史；取消后不再发送该提示的排队或新增片段。保留会话供后续提示使用，提示成功、失败或取消后均移除桥接订阅。
- `session/close` 从会话表删除会话、阻止后续通知、取消活动提示并调用 `session.dispose()`。连接断开时释放所有会话；创建过程中断开连接时，创建完成后立即释放。未知或已关闭的会话返回 `-32602`。没有会话恢复或持久化保证。

## 自主工具执行与文件变更

Pi 在桥接器进程内自主执行已启用工具，不额外请求 ACP 权限确认。工具权限与可访问路径遵循工作区配置，不构成安全沙箱。

- `tool_execution_start` 映射为 `tool_call`（`in_progress`）；增量结果映射为 `tool_call_update`（`in_progress`）；结束映射为 `completed` 或 `failed`。使用 Pi 的 `toolCallId` 关联，保留 `rawInput` / `rawOutput`，文本结果作为工具内容返回。
- 工具 `path` 相对会话 `cwd` 解析，支持绝对路径与 `~/`。ACP `locations.path` / `Diff.path` 按 SDK 契约使用绝对文件路径，而非 URI；导航位置的 `_meta["pi-acp-bridge/uri"]` 同时提供编码后的 `file:` URI。读取使用 `offset`（默认 1），修改结束使用首个变更行，坐标均为 1-based。
- 对 `edit` / `write`，在开始及结束事件的同步监听器中读取真实文件，不在异步发送队列中读取。内容发生变化时，在结束通知的 `content` 中加入 `{ type: "diff", path, oldText, newText }`；新文件的 `oldText` 为 `null`。无法读取快照时不伪造 Diff；失败但实际产生变更时仍报告真实变更。快照按提示及工具调用隔离，提示结束后释放；仅覆盖这两个命名工具，不追踪 bash 或嵌套脚本的任意文件变更。
- 已配置的 `ask_user_question` 工具开始执行时，将 `questions[].question` 与 `options[].label` / `description` 转为聊天正文中的编号 Markdown 列表，并标注多选。此处只提供展示映射，不注册问卷工具，也不实现工具等待、答案回传或 ACP 扩展 UI；这些能力仍由提供该工具的扩展负责。
- 取消及关闭继续抑制该提示后续的所有通知，包括工具结果；已经执行的文件改动不会自动回滚。

## 测试边界

`test/protocol-harness.ts` 用 `duplexPair()` 创建双向内存流，连接与 CLI 相同的 `startServer()`；测试仅收发带换行的 JSON-RPC，不查看 handler 或 Pi 的私有状态，不调用模型网络服务。

`test/initialize.test.ts` 覆盖握手、版本协商、无文件回退、自定义模型、重新发现、配置错误、密钥不泄漏与未实现认证的明确拒绝。

`test/sessions.test.ts` 在会话工厂边界注入可控会话，经过 NDJSON 验证并发路由、文本与思考流分离及顺序、流通知先于提示完成、同会话并发拒绝、取消时调用 abort、取消后的片段抑制与会话复用（包括 Pi 中止时拒绝的情况）、关闭、断线、订阅释放及失败后重试。

`test/workspace-isolation.test.ts` 使用真实 Pi `AgentSession`、项目资源发现及 `read` 工具，仅替换模型流为确定性的内存响应。经过 ACP 并发请求验证工作区指令、相对文件读取和对话内容隔离，不请求真实模型、不使用个人凭据。

`test/tools.test.ts` 使用真实 Pi 工具与确定性模型流，经 ACP 验证自主读取生命周期、导航位置、编辑及覆盖写入前后内容、新文件 Diff、失败编辑和问卷 Markdown 展示，无真实模型请求。

## 参考

- [ACP 初始化](https://agentclientprotocol.com/protocol/initialization)
- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
