# pi_acp_bridge

基于 Pi 官方 TypeScript SDK 的进程内 ACP 桥接器，面向 IDE 集成。

当前支持 stdio JSON-RPC 初始化、动态模型目录发现、独立工作区会话、文本推理流、取消及会话关闭。Pi 直接运行在桥接器进程内，不启动 Pi 子进程。

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

构建输出为单文件 ESM bundle `dist/index.js`，带 CLI shebang，可通过 `node /absolute/path/to/dist/index.js` 启动。标准输出仅用于 ACP 消息，不用于日志。

模型发现默认读取 `~/.pi/agent/models.json`，也支持 Pi 的 `PI_CODING_AGENT_DIR`。无需凭据或模型 API 请求即可完成初始化。模型列表通过 `_meta["pi-acp-bridge/models"]` 扩展返回，不等同于 IDE 原生模型选择支持。

会话使用独立内存历史，关闭后不提供恢复；推理使用 Pi 已配置的模型及凭据。工作区 `cwd` 隔离上下文与相对路径，但不限制工具访问工作区之外的文件，不构成安全沙箱。当前仅支持文本提示，不支持 ACP 登录、客户端 MCP 配置和模型切换。

协议范围、扩展格式及测试边界见 [docs/protocol.md](docs/protocol.md)。
