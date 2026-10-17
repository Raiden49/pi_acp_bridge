# pi_acp_bridge

基于 Pi 官方 TypeScript SDK 的进程内 ACP 桥接器，面向 IDE 集成。

当前支持 stdio JSON-RPC 初始化、动态模型目录发现、独立工作区持久化会话及跨客户端恢复、图片输入与工具图片输出、斜杠命令与技能自动补全、文本与思考分离的推理流、自主工具执行及结构化文件 Diff、通用原生交互表单、Thinking 配置、会话标题同步、取消及会话关闭。Pi 直接运行在桥接器进程内，不启动 Pi 子进程。

## 开发

需要通过 mise 管理的 Node.js **22.19+** 和 pnpm **12.9.1**。在已准备好的项目运行时下执行：

```sh
pnpm install --ignore-scripts
pnpm run typecheck
pnpm exec vitest run test/sessions.test.ts
pnpm run build
node dist/index.js
```

安装显式跳过依赖生命周期脚本；当前握手、测试和打包无需这些脚本。依赖只安装到项目本地，不使用全局安装。

构建输出为压缩后的单文件 ESM bundle `dist/index.js`，带 CLI shebang，无需相邻 `node_modules` 即可启动，可通过 `node /absolute/path/to/dist/index.js` 启动。标准输出仅用于 ACP 消息，不用于日志。

模型发现默认读取 `~/.pi/agent/models.json`，也支持 Pi 的 `PI_CODING_AGENT_DIR`。无需凭据或模型 API 请求即可完成初始化。初始化模型列表通过 `_meta["pi-acp-bridge/models"]` 扩展返回；创建及恢复会话通过标准 `configOptions` 提供 IDE 原生模型下拉框，使用 `session/set_config_option` 在空闲时切换当前会话模型。IDE 下拉框只展示 Pi 已配置认证的可用模型；初始化扩展仍是完整的已知模型目录，不用于填充下拉框。

会话使用 Pi 的独立 JSONL 历史，ACP ID 与文件路径保存在 `~/.pi/agent/acp-sessions.json`（遵循 `PI_CODING_AGENT_DIR`）。关闭或断开后，可以用原 ID 和相同 `cwd` 调用 `session/load` 恢复；请先关闭旧客户端，避免多个进程同时写入同一 JSONL。

图片输入支持 base64 及本地 `file:` 图片链接，实际推理需要支持视觉的模型。工具结果保留原生图片，聊天正文使用 Markdown 绝对文件链接及可复制路径，避免客户端把图片块显示成 Base64 JSON；回退文件保存在 `~/workspace/storage/media/pi-acp-bridge/`，不会自动清理。命令补全包含 `/session`、`/reload`、`/compact` 和 Pi 原有 `/name` 的兼容适配，以及当前加载的扩展、提示模板和已启用的技能；不包含未适配的终端专用命令。

推理使用 Pi 已配置的模型及凭据。工作区 `cwd` 隔离上下文与相对路径，但不限制工具访问工作区之外的文件，不构成安全沙箱。支持客户端按会话传入的 stdio / Streamable HTTP MCP 服务，通过 Pi 官方 MCP 扩展连接并提供工具；不支持旧式 SSE、ACP 内嵌 MCP 或 ACP 登录。模型切换写入会话历史，不修改全局默认模型。

交互只转换 Pi 的 `select/confirm/input/editor` 为标准 ACP `elicitation/create` 表单，不新增问答工具或针对插件做特殊处理。IDE 必须声明表单能力；取消不会被当作批准。输入框保留输入语义，不从文案猜测多选。Thinking 使用原生配置项，标题通过 `session_info_update` 同步；均不依赖额外问答命令。

构建分发与验收边界见 [docs/releasing.md](docs/releasing.md)。

JetBrains Air 注册步骤及真实界面验收清单见 [docs/air-integration.md](docs/air-integration.md)。

协议范围、扩展格式及测试边界见 [docs/protocol.md](docs/protocol.md)。
