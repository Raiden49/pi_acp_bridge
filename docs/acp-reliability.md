# 第一批可靠性修复：实现依据与验收边界

本轮针对 [差距分析](acp-gap-analysis.md) 的 A1–A6 与 B2 落地；不重写 ACP 服务，不修改个人 IDE/profile 配置。保留既有 `session/delete` 永久删除语义；MCP 冲突按用户选择采用 **Pi 原生配置优先**。

## 修复与复用边界

| 项目 | 本地实现 | 复用/参考 |
| --- | --- | --- |
| 模型失效恢复 A1 | 当前模型缺失/不可用时保留 selector、明确诊断项和可用替代项；不自动切换旧会话 | Pi `ModelRuntime` 可用快照与 SDK scope 匹配；不自建模型/认证目录 |
| 取消收尾 A2 | 只跟踪已实际发出的工具；允许真实 terminal result，缺失结果时关闭为 failed 并说明未知；先 drain 再返回 | Claude ACP 的 foreground tool closure；ACP 要求取消后仍处理收尾更新 |
| 自定义消息 A3 | 实时与回放共用 `customMessageUpdates()`；仅展示 `display: true`；图片复用已有链接映射 | SDK `sessionEntryToContextMessages()`，遍历完整 branch 而非压缩投影，不自己重建 Pi 历史格式 |
| 错误诊断 A4/A5 | 操作边界保留具体原因/有限 Error cause，清除任意 error data，保留协议 code 与租约 reason 白名单；URL/header/token 脱敏 | Codex ACP 的错误解释边界；不把原始 error/request/config 对象直接返回客户端 |
| 原生能力 A6 | 注入具名可替换的 `mcp`、`codemode`、`tool-search`；IDE 服务器仅经 `registerMcpServer()` 注册 | Pi CLI 内置扩展描述格式、`createMcpExtension()` 的配置/连接/重连/OAuth/shutdown；删除自建 MCP loader/transport |
| 只读诊断 B2 | `/doctor` 显示 Bridge/Pi/Node、启动路径、加载时模块 SHA-256、profile/模型/刷新、扩展错误/fallback 与 MCP 来源入口 | SDK 的 settings、auth source、model registry、resource loader 查询；不调用模型、不打印 credential 值、不实现第二套 MCP 状态机 |

ACP env/header 已经是解析后的 literal。适配层按 Pi 公开模板规则转义 `$` 和开头 `!`，防止 IDE 注入值被二次展开或作为命令执行；Pi 原生配置保留自己的模板语义。命名空间覆盖、可信项目配置和 builtin 禁用都由 SDK 决定。

## 分发契约

Pi 原生 MCP 可能激活 codemode，不能只检查工具注册成功。按 Pi Node 构建脚本拆出自包含 worker，交给 SDK 按 data URL 启动；worker 不带主入口的 createRequire/import.meta banner。QuickJS WASM 作为同目录资源，构建适配将 SDK 的包解析路径替换为该资源路径；SDK loader 特征变化时明确构建失败。

完整分发文件：

```text
dist/index.js
dist/codemode-worker.js
dist/quickjs.wasm
```

独立包测试只复制这些文件与隔离扩展 fixture，拒绝解析开发目录依赖，实际执行原生 codemode `return 6 * 7;` 并检查结果 42；也验证 `/doctor` 的 SHA-256 与运行入口文件一致。没有实现新的沙箱或自建 worker 协议。

## 参考来源

- Claude ACP 固定快照：[0ce42f2](https://github.com/agentclientprotocol/claude-agent-acp/tree/0ce42f2c312d190f78024d8b4b1ae5f00d9e5939)，工具取消与 foreground lifecycle。
- Codex ACP 固定快照：[582e545](https://github.com/agentclientprotocol/codex-acp/tree/582e545eb1868763645ea59b1a2c106e50d5d471)，错误解释与 MCP 边界；不照搬其后端私有接口。
- ACP v1 固定快照：[c3790ac](https://github.com/agentclientprotocol/agent-client-protocol/tree/c3790ac34421633c3c1cdbbdff964b647270cec9/docs/protocol/v1)，取消、生命周期和删除语义。
- Pi Node 构建：[973b74c/scripts/build-coding-agent-bundle.mjs](https://github.com/earendil-works/pi/blob/973b74c55fcf096ad5976f8d8850c147ee2e62d4/scripts/build-coding-agent-bundle.mjs)，独立 codemode worker 及 data URL 限制；下载快照与该 commit 的文件逐字节一致。
- 本地锁定 **Pi SDK 1.2.0** 的公开 exports、`docs/sdk.md`、`docs/mcp.md`、`docs/codemode.md`、`examples/sdk/14-codemode-mcp.ts`；对照 CLI 内置扩展列表、SDK resource loader、模板解析、history conversion 与 codemode executor 实现。内部文件只用于确认行为；运行时通过 SDK 根 exports 使用扩展工厂/注册 API，不深层导入未导出的 SDK 模块。构建期读取 SDK worker/config 文件有明确兼容检查与独立包用例。

## 验证记录与限制

逐项添加最小失败用例后修复；测试不调用真实模型、不修改个人配置。最终定向验证：

- `errors`、`model-recovery`、`model-sync`、`scoped-models`、`models`、`sessions`、`custom-messages`、`tools`：8 文件 **31 项通过**。
- `mcp`、`commands`、`bundle`、`delete-session`、`session-lease`、`persistence`：6 文件 **18 项通过**。
- `pnpm run typecheck` 通过。`bundle` 测试内运行生产构建并验证独立产物，不代表全套测试通过。
- MCP 使用真实 SDK + 本地 stdio/HTTP 假服务器，覆盖原生/可信项目优先、归一化冲突、literal env/header、codemode 实际调用 MCP、tool_search 注册和 builtin 禁用；测试后检查无相应残留子进程。
- **未进行真实 Air/JetBrains UI 验收、真实 provider 调用、远端 OAuth 或远端 MCP 验收**。协议工具终态通过不等于实际客户端 spinner/diff 已验证。仍需极简人工检查模型恢复、取消、扩展历史输出。

脱敏不是任意文本的完整 DLP。`/doctor` 仍包含工作区/profile 路径和 provider/model 名称，分享前应检查；`/mcp` 的详细输出由 Pi 管理。诊断的刷新状态只记录该活动会话内的尝试，不当作跨进程历史。新构建需要重启代理；`/reload` 不加载新版 Bridge，也不同步终端改写的历史。

权限/Plan 模式、IDE 未保存文件代理、session fork、软删除、后台终端及 ACP v2 不属于本轮。
