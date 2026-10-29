# Pi 1.4、运行中配置与扩展模型恢复

## 决策与参考

采用现有 Pi 原生能力，不复制其他适配器的 RPC 通信层或另建一套期望模型状态。

- [Codex ACP](https://github.com/agentclientprotocol/codex-acp/blob/3f6d371b142efc1bc7efe66de665c511d7744a6c/src/CodexAcpServer.ts#L2666)：及时接受会话配置，已发送请求不被改写。Pi 的具体生效边界以自身 SDK 为准。
- [svkozak/pi-acp](https://github.com/svkozak/pi-acp/blob/04d0a15d6bb42bb65cce5c9caedcdcb2cdcb6905/src/acp/agent.ts#L1169)：将 model/Thinking 交给 Pi 原生 RPC，而非统一等待完整 prompt 结束。
- [regadas/pi-acp](https://github.com/regadas/pi-acp/blob/2f478724144bdc7a7da2f78e97faa2c41a853c39/src/acp/agent.ts#L1560)：配置事务串行，读取真实状态并有序发布。它是 svkozak 的维护 fork，不作为独立投票。
- [openma-ai/pi-acp](https://github.com/openma-ai/pi-acp/blob/ffea89d285ea6d8219a4b86f23429f4ebf5e644e/src/acp/session.ts#L264)：SDK services 先初始化再恢复历史。其运行中禁止切模型、允许 Thinking 的策略与本项目不同；其 `persist: true` 也不照搬。
- Pi 1.4 的公开 SDK 与原生 RPC：model/Thinking 调用 session setter；SDK 在后续 assistant 请求准备边界刷新选择。services API 处理扩展 provider、native provider 和 virtual model 的提前注册。

外部适配器并非对运行中切模型存在共识。Bridge 选择跟随 Pi 原生 setter，通过真实 SDK 的假 provider 定向测试验证边界，不将源码先例等同于 IDE 验收。

## 实现

### 配置事务

`src/server.ts` 的同会话配置队列串行执行校验、原生 setter、读取/发布完整配置；失败不阻塞后续事务，并尽力补发权威配置。模型与 Thinking 继续使用 `persist: false`，不写全局启动默认。

- 普通模型提示运行时接受 model/Thinking，以及旧 Thinking mode/config 入口；不为它们等待整个 ACP prompt 结束。
- 已发出的请求保持原配置；工具循环后的下一次 assistant 请求可能使用新模型和 Thinking。配置响应描述实际选定状态，不追溯改变旧请求。
- Tool policy 仍仅空闲时修改；Bridge 命令和取消期间拒绝新修改；普通提示进入结算不丢弃已排队的配置。
- reload 与提示结算的配置快照在同一队列内计算/发布，避免预先读取的旧快照覆盖后续选择。
- 后收到的提示等待配置队列；等待可取消，不得因配置稍后完成而启动已取消的提示。
- close/delete/shutdown 阻止未开始的配置写入，等待已开始且不能可靠取消的 SDK setter，然后清理。已开始的 setter 可正常完成并返回，不伪造回滚；已关闭会话不发布配置。分叉仍要求源会话没有活动提示、等待提示或配置事务。
- 可选 trace 只记录配置阶段、错误码与成功后的真实模型/Thinking，不记录任意请求值、正文或认证。不增加自动切模型、超时或重试机制。

### 恢复初始化

`src/sessions.ts` 使用 `createAgentSessionServices()` 加载扩展并完成注册/本地刷新，再使用 `createAgentSessionFromServices()`。沿用编辑器、MCP 与审批 extension factories，后续 bind/shutdown/dispose 仍使用现有 SDK 生命周期；services 诊断保留在启动提示中，经既有出口脱敏。

不手工扫描最后一条 `model_change`。历史模型成功恢复时保持模型与 Thinking，包括 scope 外的有效历史；仅真正恢复失败时重用既有 scoped fallback。不会扩大可选范围，也不会把缺少 provider 推断为凭据过期。

### 升级

`package.json` 中 `pi-coding-agent`、`pi-ai`、`pi-mcp` 固定为 1.4.0，lockfile 同步同族依赖及升级实际引入的依赖，不全量更新其他包。

独立包继续采用受保护的 SDK VERSION/WASM 适配，分发相邻的 `index.js`、`codemode-worker.js`、`quickjs.wasm`。升级未要求修改该适配。全局 CLI、个人设置、认证和历史均未修改。

## 验证边界

- `live-configuration`：真实 Pi SDK + 本地假 provider，验证同一 ACP prompt 后续请求使用新配置、并发事务、失败补发、提示等待与取消、关闭的写入边界。
- `model-recovery`：真实扩展通过 `pi.registerProvider()` 注册历史模型，恢复前可见；模型在 scope 外仍保持成功恢复；真正缺失时仍 scoped fallback；隔离 settings 字节不变。
- 受影响的模型、scope、配置同步、reload、持久化与会话目录契约；会话关闭、删除、分叉、steering、审批、编辑器文件与 MCP 定向回归。
- `bundle`：真正重建独立包并禁止外部模块/模型网络，核对 Pi SDK 版本，执行扩展、OAuth、图片、codemode 及本地 MCP 重启/退出清理。

最终分三组定向执行：9 文件 21 项、8 文件 49 项、3 文件 6 项，共 **20 文件 76 项通过**；`typecheck` 与 `git diff --check` 通过。独立包测试已重建 dist，并核对实际打包的 Pi SDK 为 1.4.0。

本机 pnpm 对被阻止的依赖构建脚本报错，最终通过 `pnpm install --ignore-scripts --config.strictDepBuilds=false` 完成安装；选项仅当前命令有效，未批准依赖脚本或修改全局配置。上述类型、定向测试和独立包验证使用的就是该安装结果。

定向验证与真实 IDE/真实提供方验收分开。没有全量测试、真实模型调用或 IDE 重启；未复现的截图无响应问题不在本次修复范围内。更新生效需要真正重启 agent，`/reload` 不加载新版 Bridge。
