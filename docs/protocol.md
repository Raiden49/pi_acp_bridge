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
- `session/prompt` 在调用 Pi 前订阅事件，将 `message_update` / `text_delta` 映射为 `session/update` 中的 `agent_message_chunk`，将 `thinking_delta` 单独映射为 `agent_thought_chunk`，均使用 `{ type: "text", text: delta }`。思考不混入回复正文，客户端可将其渲染为可折叠区块。两类通知共用有序发送队列，按序排空后才返回提示结果。不转发工具调用或其他 Pi 事件。
- 不同会话可以并发；同一会话已有活动提示时返回 `-32600`，不隐式排队。正常结束返回 `end_turn`，长度截断返回 `max_tokens`，取消返回 `cancelled`。Pi 推理错误返回不含原始提供商细节的 `-32603`。
- `session/cancel` 立即调用 Pi `abort()`，活动提示结算为 `cancelled`；即使 Pi 的提示 Promise 因中止而拒绝，也不返回推理错误。已发送的文本和思考片段不撤回，不清空 Pi 历史；取消后不再发送该提示的排队或新增片段。保留会话供后续提示使用，提示成功、失败或取消后均移除桥接订阅。
- `session/close` 从会话表删除会话、阻止后续通知、取消活动提示并调用 `session.dispose()`。连接断开时释放所有会话；创建过程中断开连接时，创建完成后立即释放。未知或已关闭的会话返回 `-32602`。没有会话恢复或持久化保证。

## 测试边界

`test/protocol-harness.ts` 用 `duplexPair()` 创建双向内存流，连接与 CLI 相同的 `startServer()`；测试仅收发带换行的 JSON-RPC，不查看 handler 或 Pi 的私有状态，不调用模型网络服务。

`test/initialize.test.ts` 覆盖握手、版本协商、无文件回退、自定义模型、重新发现、配置错误、密钥不泄漏与未实现认证的明确拒绝。

`test/sessions.test.ts` 在会话工厂边界注入可控会话，经过 NDJSON 验证并发路由、文本与思考流分离及顺序、流通知先于提示完成、同会话并发拒绝、取消时调用 abort、取消后的片段抑制与会话复用（包括 Pi 中止时拒绝的情况）、关闭、断线、订阅释放及失败后重试。

`test/workspace-isolation.test.ts` 使用真实 Pi `AgentSession`、项目资源发现及 `read` 工具，仅替换模型流为确定性的内存响应。经过 ACP 并发请求验证工作区指令、相对文件读取和对话内容隔离，不请求真实模型、不使用个人凭据。

## 参考

- [ACP 初始化](https://agentclientprotocol.com/protocol/initialization)
- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
