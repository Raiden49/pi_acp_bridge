# pi_acp_bridge

基于 Pi 官方 TypeScript SDK 的进程内 ACP 桥接器，面向 IDE 集成。

当前实现为项目骨架：stdio JSON-RPC 初始化握手及动态模型目录发现。会话与推理功能尚未实现。

## 开发

需要通过 mise 管理的 Node.js **22.19+** 和 pnpm **12.9.1**。在已准备好的项目运行时下执行：

```sh
pnpm install --ignore-scripts
pnpm run typecheck
pnpm exec vitest run test/initialize.test.ts
pnpm run build
node dist/index.js
```

安装显式跳过依赖生命周期脚本；当前握手、测试和打包无需这些脚本。依赖只安装到项目本地，不使用全局安装。

构建输出为单文件 ESM bundle `dist/index.js`，带 CLI shebang，可通过 `node /absolute/path/to/dist/index.js` 启动。标准输出仅用于 ACP 消息，不用于日志。

模型发现默认读取 `~/.pi/agent/models.json`，也支持 Pi 的 `PI_CODING_AGENT_DIR`。无需凭据或模型 API 请求即可完成初始化。模型列表通过 `_meta["pi-acp-bridge/models"]` 扩展返回，不等同于 IDE 原生模型选择支持。

协议范围、扩展格式及测试边界见 [docs/protocol.md](docs/protocol.md)。
