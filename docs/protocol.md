# ACP 初始化协议

## 当前范围

本阶段仅提供 ACP v1 初始化握手与模型发现。`session/new`、`session/prompt`、`authenticate` 返回 JSON-RPC `-32601`，会话、推理、模型切换与登录流程留待后续实现。取消通知不产生响应。没有启动 Pi 子进程。

`initialize` 返回：

- SDK 的 `PROTOCOL_VERSION`：收到不同版本时返回本服务支持的版本，由客户端决定是否继续。
- `agentInfo`：`pi-acp-bridge` 及来自 `package.json` 的版本。
- `agentCapabilities.loadSession: false`：不宣称尚未实现的能力。
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

## 测试边界

`test/protocol-harness.ts` 用 `duplexPair()` 创建双向内存流，连接与 CLI 相同的 `startServer()`；测试仅收发带换行的 JSON-RPC，不查看 handler 或 Pi 的私有状态，不调用模型网络服务。

定向测试覆盖握手、版本协商、无文件回退、自定义模型、重新发现、配置错误、密钥不泄漏与未实现会话的明确拒绝。

## 参考

- [ACP 初始化](https://agentclientprotocol.com/protocol/initialization)
- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
