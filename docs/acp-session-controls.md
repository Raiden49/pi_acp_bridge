# 第三批：分叉、追加输入与工具审批

本轮由用户确认的范围：**当前分支末尾分叉、steering、会话内可选审批/Plan**。默认保持直接执行；不新增全局权限设置，不实现终端委托、独立后台任务、指定消息位置分叉或 ACP v2。

## 先核对的成熟实现

| 依据 | 核对内容 | Bridge 采用与差异 |
| --- | --- | --- |
| [Claude ACP `acp-agent.ts`](https://github.com/agentclientprotocol/claude-agent-acp/blob/0ce42f2c312d190f78024d8b4b1ae5f00d9e5939/src/acp-agent.ts) 的 `steer()`、请求解析与初始化 | `_session/steering`、`_meta.steering.supported`、`promptRequired`、旧客户端空闲时启动提示的兼容行为 | 使用已有 v1 扩展契约；运行时执行与输入转换交给 Pi，不复制 Claude CLI 的优先级/interrupt 管线 |
| 同一 Claude 实现的 `requestPermissionFromClient()` | 先发布工具，再请求审批；传递取消信号，并额外 race 本地 abort，防止不响应取消的客户端挂住执行 | 排空 Bridge 通知后确认工具已发布；使用当前 ACP SDK 的公开 `request(CLIENT_METHODS.session_request_permission, ..., { cancellationSignal })`，另保留本地 abort race；拒绝、取消、RPC 失败和迟到批准均不放行 |
| [Codex ACP `session-fork.ts`](https://github.com/agentclientprotocol/codex-acp/blob/582e545eb1868763645ea59b1a2c106e50d5d471/src/SessionFork.ts) 与 [Claude AIR 文档](https://github.com/agentclientprotocol/claude-agent-acp/blob/0ce42f2c312d190f78024d8b4b1ae5f00d9e5939/docs/air-extensions.md) | 独立会话 ID、分叉会话恢复信息，以及指定消息位置的 AIR 元数据契约 | 实现 ACP SDK 的 `unstable_forkSession`，广告 `sessionCapabilities.fork`；不广告 AIR 指定消息位置能力，收到 `_meta.jetbrains.air.fork` 明确拒绝，绝不悄悄改成末尾分叉 |
| 已安装 Pi SDK **1.2.0** 的公开接口及对应实现 | `SessionManager.createBranchedSession()`；`AgentSession.prompt()` / `PromptOptions.preflightResult`；Pi RPC 对该预检回调的使用；extension `input`、`before_agent_start`、`tool_call` 和 `ctx.executeTool()` | 运行时只用公开 exports。核对文件为安装包 `dist/core/{session-manager,agent-session,nested-tool-calls}.js`、`dist/core/extensions/{types.d.ts,runner.js}`、`dist/modes/rpc/rpc-mode.js`。不手写 Pi JSONL、嵌套执行管线或替换算法 |

这些比较不代表上游与 Bridge 具有完全相同的权限引擎。Claude/Codex 可以依赖各自运行时的原生策略；**Bridge 的三档工具策略是针对 Pi 的明确适配，不是宣称 Pi 自带 Claude 权限模式或所有 ACP 客户端都支持相同 UI。**

## 分叉

- ACP SDK 实验性的 `session/fork` 要求原工作区绝对 cwd；支持已加载但空闲、或已关闭且能发现的持久化会话。源会话正在提示/配置变更时拒绝；分叉期间阻止同一源会话的新操作，与 load/delete 协调。
- 为源文件使用独立 `SessionManager.open()`，在活动 leaf 调用 `createBranchedSession()`，创建新原生 ID 和新 JSONL。**不调用会替换当前 runtime 的 `fork()`。**源会话对象与源文件保持原样，新会话单独绑定编辑器、审批状态与写租约。
- 已关闭源先取得 Bridge 历史租约；已加载源复用它持有的租约。创建失败时只在持有新文件租约的前提下清理自己的新历史/索引，绝不删除源历史；清理失败会记录 `fork_cleanup_failed`。原版 Pi CLI 仍不遵守 Bridge 租约。
- 空白、尚无对话的会话不可分叉。只复制当前分支历史，不复制工作区快照、不撤销任何文件修改，也不在 fork 响应期间重放消息；需要回放时使用 `session/load`。
- 新会话走独立会话的正常扩展绑定，而非 Pi 交互式分支导航流程；不承诺触发后者专属的 `session_before_fork` 等导航钩子。模型/Thinking 依照 Pi 持久化恢复与既有可用性规则；不可用模型不伪造为可调用。

## Steering

- 初始化广告 `_meta.steering = { supported: true }`，入口为 `_session/steering`，参数是非空 `sessionId`、非空 ACP `prompt` 数组；复用既有文本、资源来源及图片解码，不另造内容格式。
- 运行中使用 Pi RPC 同样的 `prompt(..., { streamingBehavior: "steer", preflightResult, source: "rpc", expandPromptTemplates: false })`。直接调用 `steer()` 会在异步 input handler 跨过运行结束时留下待处理队列；公开的 prompt 预检机制可在 SDK 已空闲时继续运行，Bridge 将该工作计入原提示生命周期并等待结算。
- `injected` 表示 SDK 预检已经接收输入（包括扩展自行处理），不是保证模型已经看到每个字，也不是停止当前工具。正常消费时点遵循 Pi：当前工具结束后、下一次模型调用前。拒绝在运行中注入 Bridge 本地命令；不把输入解释为新的扩展命令执行。
- 没有活动提示时，`_meta.steering.idleBehavior: "promptRequired"` 返回 `{ outcome: "promptRequired", reason: "noRunningTurn" }`，由客户端提交普通 prompt；不修改或偷偷消费输入。为兼容既有契约，未设置该字段时返回 `startedNewTurn` 并启动受生命周期管理的普通提示；异步失败提供脱敏反馈。
- 本地命令/配置变更、取消及结算窗口拒绝追加。已接收的异步输入随提示排空；取消标记也进入最后的 `input` 钩子，迟到转换不会启动新模型运行；取消结算清空 SDK 队列。不用“取消后重发”冒充 steering，也没有新增 follow-up 协议。

## 工具策略

`configOptions` 新增 `id: "approval"`、名称 **Tool policy**，通过 `session/set_config_option` 切换。传统 `modes` 现在与 direct/ask/plan 工具策略同步，`session/set_mode` 接受这些策略值；不再将模型相关 Thinking 档位放进无法完整动态更新的 legacy modes。旧客户端缓存的 Thinking mode ID 仍可调用兼容入口。迁移依据与回归见 [模型同步修复](acp-model-sync-fix.md)。

| 值 | 行为 |
| --- | --- |
| `direct` | 新会话默认；保持原有直接执行 |
| `ask` | `read/grep/find/ls`、codemode 容器与 tool_search 可直接运行；其他工具逐次发标准 ACP 审批，仅提供 Allow once / Reject，不保存永久授权 |
| `plan` | 同样允许上述检查/计算入口；阻止 edit/write、所有 shell、MCP 与未知工具。不通过 shell 文本解析猜测“只读” |

- 非可替换的隐藏 `acp-tool-policy` 扩展位于用户扩展之后，在 Pi 执行前 `tool_call` 拦截；codemode 的 `ctx.executeTool()` 走同一 SDK 管线，不能通过嵌套调用绕过。system prompt 仅辅助说明，真正的阻止由工具钩子完成。
- 审批展示经过脱敏的参数；工具通知先于审批请求。同一排队约束也用于既有 elicitation 表单入口，修复其可能先发问答、后发布工具的时序竞态，不更改表单协议。SDK 发出 `$/cancel_request`，但客户端不响应时本地仍能取消等待；迟到响应不执行工具、不保存授权，也不宣称能强制关闭每种客户端的对话框。客户端不支持审批或请求失败时拒绝执行，不降级为 direct。
- 策略按会话保存，不修改全局设置。对话中的权威记录是 Pi `appendCustomEntry()` 元数据；索引的 `approvalMode` 是未落盘/旧 setup-only 历史的恢复后备。恢复时原生分支记录优先，无原生记录才应用后备并补入 manager，以便首轮对话持久化。空白 Plan 会话关闭/恢复不会静默降级；分叉继承分支中保存的策略。
- 自定义会话工厂若未加载拦截器，不广告无法执行的选项。`/doctor` 显示当前策略和适配边界。

**这不是安全沙箱。**用户扩展受信任、在宿主进程运行，可以重写同名工具或在 input/命令/生命周期钩子自行调用 Node/fs/bash；不能用 Bridge 的工具 allowlist 隔离恶意插件。Plan 约束的是正常 Pi 工具调用管线，不能保证第三方代码没有副作用。工作区路径、symlink、网络、profile、IDE 保存行为也没有因此获得 OS 级隔离。取消不回滚已经批准并发生的修改。

## 验证与边界

测试仅使用隔离目录、真实 Pi SDK、本地假模型与假 ACP 审批客户端，无真实 provider 调用或个人配置修改。

- `test/fork.test.ts`：活动源拒绝、独立 ID/历史、源文件不变、源可继续使用、分叉可恢复/独立写入、已关闭源可分叉、指定消息位置拒绝。
- `test/steering.test.ts`：真实工具执行中追加；空闲 promptRequired 与旧式默认；异步 input handler 跨过 SDK idle 仍纳入原提示；取消后迟到 input 不进入模型。
- `test/approvals.test.ts`：默认 direct、逐次批准/拒绝、审批不可用 fail-closed、工具先发布、嵌套审批、Plan 对 write/shell/未知工具/嵌套 write 的实际阻止、空白与已有对话恢复、分叉继承、迟到批准和下一轮重新审批。

最终定向验证 **20 个文件、80 个测试通过**（不是全量套件）；`pnpm run typecheck` 与 `git diff --check` 通过。三组命令分别覆盖本轮与持久化边界、协议/配置/表单、独立分发与文件/MCP 集成，每组均在 30 秒内完成：

```sh
pnpm exec vitest run test/approvals.test.ts test/steering.test.ts test/fork.test.ts test/session-index.test.ts test/session-catalog.test.ts test/pending-session.test.ts test/delete-session.test.ts test/session-lease.test.ts
pnpm exec vitest run test/initialize.test.ts test/sessions.test.ts test/configuration-sync.test.ts test/models.test.ts test/model-sync.test.ts test/commands.test.ts test/tools.test.ts test/questions.test.ts
pnpm exec vitest run test/bundle.test.ts test/client-filesystem.test.ts test/mcp.test.ts test/persistence.test.ts
pnpm run typecheck
git diff --check
```

独立 bundle 测试已重建生产分发物，并从不依赖开发目录的副本执行 codemode 等既有烟测。真实 Air/JetBrains 的分叉入口、steering 控件、Tool policy 选择器、审批弹窗和取消展示仍须人工验收。协议/SDK 定向通过不等于 IDE UI 已验收；本轮不实现终端/后台任务，也不提供任意消息位置分叉。
