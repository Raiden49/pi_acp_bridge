# ACP 实现对标与体验缺口分析

调研日期：2026-10-27。

> 后续实施状态：第一批已针对 A1–A6 与 B2 落地，详见 [可靠性修复](acp-reliability.md)；第二批已完成编辑器文件工具适配、上下文来源、MCP 状态/定向重连验证及配置同步，详见 [IDE 体验与上游依据](acp-ide-experience.md)。以下缺口和复现记录描述的是**调研基线**，不是修复后现状；原 `.scratch` 审计测试记录旧行为，不应作为修复后的回归目标。用户明确选择保留永久删除，并采用 Pi 原生 MCP 配置优先。第三批已按用户确认范围完成末尾分叉、steering 与会话内审批/Plan，详见 [会话控制与上游依据](acp-session-controls.md)；终端/后台任务、指定消息位置分叉和其他规模风险仍未实施。

## 结论

目前 Bridge 的基本链路已经具备实用性：工作区隔离、流式文本/思考、工具与 Diff、模型/Thinking、Pi 原生历史恢复、跨 Bridge 写租约、MCP 注入和表单都有实现。主要问题不是“ACP 接口太少”，而是 **Pi CLI 与 SDK 的语义没有完全拉齐，失败/取消/恢复路径不够完整，以及 IDE 特有能力还没有充分利用**。

建议先修复恢复路径和可诊断性，再引入编辑器文件系统、权限/Plan、分叉等能力。不要为了看齐竞品功能数量直接重写 Bridge，也不要立即追逐 ACP v2 草案。

调研轮次只新增调研文档和 `.scratch/acp-research/` 调研资料/复现测试，未修改产品源码。分析基于 HEAD `19e6ed2499c2b3b13f2ab5936e1399944c8e41b6` 加当前未提交改动，包含上一轮模型刷新与错误处理修改；不是只审查 HEAD。

## 调研范围与证据等级

外部实现均通过 GitHub API 读取源码并固定提交，不依赖搜索摘要判断功能。比较的是以下主分支快照，**不保证所有能力已进入稳定发行版**，更不表示已在本机 Air 验收。

| 参照 | 固定提交 | 主要借鉴点 |
| --- | --- | --- |
| [Claude Agent ACP][claude] | `0ce42f2c312d190f78024d8b4b1ae5f00d9e5939` | 工具生命周期、编辑器集成、权限、结构化失败、扩展能力协商 |
| [Codex ACP][codex] | `582e545eb1868763645ea59b1a2c106e50d5d471` | 会话分叉、模型/权限配置、MCP 状态、后台任务、错误恢复 |
| [Gemini CLI ACP][gemini] | `363a13119a57354f469732577518b9d6b319d1d6` | 原生 CLI 集成、文件系统能力路由、工具审批、集中错误映射 |
| [ACP 协议][protocol] | `c3790ac34421633c3c1cdbbdff964b647270cec9` | 区分标准接口、可选能力、草案及客户端扩展 |

证据分类：
- **已复现**：使用隔离的内存/协议测试确认当前后端行为；不等于客户端 UI 已复现。
- **源码确认**：本项目和必要时上游源码明确存在该行为/缺口。
- **待验证风险**：代码路径具有风险，但没有性能数据或真实客户端复现，不列为确定故障。

优先级：P1 为近期可靠性/恢复/数据安全工作，P2 为体验和功能增强，P3 为后续投资。本轮不声称发现了已证实的 P0 漏洞。

## 一、近期应修复的缺口

### A1 / P1：当前模型不可用时，整个模型选择器消失【已复现】

位置：`src/models.ts:52-55`。

`sessionConfiguration()` 要求当前模型仍在可选列表里，否则返回 `configOptions: []`。即使还有其他已认证模型，也不会给用户展示替代项。

触发：当前模型从 models.json 删除，或其 provider 不再可用，再刷新/恢复会话。

影响：用户在最需要切换模型时失去下拉框，只能新建会话、修改外部配置或使用其他入口。上一轮的刷新修复没有解决这一恢复路径。

建议：明确建模“当前选择失效”，保留诊断与有效替代模型。可选方案是提供明确不可用的当前项及警告，或采用用户可见的回退流程；需要验证目标客户端是否允许该配置形态，不能静默替换模型或伪装认证成功。

### A2 / P1：取消会丢掉已展示工具的终态【已复现】

位置：`src/server.ts:367-376,396,486-493`；`src/tool-updates.ts`。

取消先设置 `active.cancelled = true`，事件监听器随后直接忽略所有事件，发送队列也跳过任务。因此 Pi 在 abort 时发出的 `tool_execution_end` 无法抵达客户端。

最小复现结果：客户端收到 `tool_call/status=in_progress`，随后 prompt 返回 `cancelled`，但没有工具结束更新。

影响：后端状态与客户端工具状态不一致；是否表现为持续转圈、失败卡片或被 UI 自动结束取决于客户端，尚未做 Air 实测。

建议：区分“禁止继续生成内容”和“允许生命周期收尾”；跟踪本轮已公开工具，处理真实终态。后端确实结束且没有终态时，再按协议可表达的状态补充说明，不把未知结果伪造成成功。Claude 的实现也专门处理停止后缺少结果的工具收尾，见 [Claude 源码][claude-agent] 和其 README 的取消说明。

### A3 / P1：Pi 扩展自定义消息被忽略【回放已复现；实时路径源码确认】

位置：`src/history.ts:5-15`；`src/server.ts` 的 prompt 事件处理。

Pi `sendCustomMessage()` 能发送 `role: custom` 消息，持久化为 `custom_message` entry，并产生 `message_start/message_end`。Bridge 实时只处理 assistant 的文本/思考 delta；回放只读取 `entry.type === "message"`，随后也只识别 user/assistant/toolResult。

影响：扩展命令执行成功，但用户看不到它通过自定义消息输出的结果；恢复历史也无法补回。某些扩展通过 `ui.notify()` 输出不受此问题影响，不能据此认为全部扩展输出都丢失。

建议：为 `display: true` 的自定义消息提供文本/内容块降级显示，实时与回放共用映射；`display: false` 不应展示，自定义 TUI/renderer 另行声明不支持。

### A4 / P1：错误脱敏还不是完整安全边界【已复现】

位置：`src/errors.ts`，以及 `src/server.ts` 的 prompt 异常透传。

上轮修复保留具体原因是正确方向，但正则只覆盖部分字段和凭证格式。例如：

```text
Request failed: https://example.invalid?token=credential-value
```

`errorDetail()` 当前会原样保留 `token` 的值。第三方 provider 错误可能包含请求 URL，导致把凭证写进客户端聊天/错误记录。

建议：对 URL query、userinfo、敏感头及字段做结构化脱敏，覆盖明确支持的凭证形态；未知错误保留有用摘要但不直接转发请求/配置 dump。不要把“多加几条正则”描述成任意凭证都不会泄露。

### A5 / P1：错误原因仍有多处被统一吞掉【源码确认】

位置：`src/server.ts:174-176,235-237,310-314`；`src/extension-ui.ts:28-31`。

prompt 的错误已改善，但创建会话、恢复、模型切换仍返回泛化错误；扩展执行错误除终端对话特例外也统一替换。当前模型失效、扩展缺依赖、MCP 连接失败、历史文件损坏等依然可能表现为“请检查配置”。SDK factory 返回的 `modelFallbackMessage` 也没有被 Bridge 展示。

建议：统一错误映射：操作阶段 + 脱敏原因 + 可行动建议。保留安全的错误码/类别；区分认证、配置、网络、provider 限流、扩展和存储问题。针对性借鉴 [Codex 错误解释器][codex-errors]，不要仅把原始 exception 全盘转发。

支持的客户端可再协商使用 [Claude 的 session failure 扩展][claude-failure]；普通 ACP 客户端仍保留清晰文本和 JSON-RPC 错误，不强制依赖 AIR 私有扩展。

### A6 / P1：Pi CLI 的内置 MCP/codemode/tool_search 不会因使用 SDK 自动对齐【源码确认的默认路径缺口】

位置：`src/sessions.ts:46-50`；`src/client-mcp.ts`。

Pi SDK 文档明确说明：CLI 默认注入的 codemode、tool_search、MCP built-ins，需要 SDK 宿主主动添加对应 extension factories。CLI 的 `dist/main.js` 会合并 `builtInExtensions`，Bridge 则只在客户端传入 MCP 时注入自定义 `clientMcpExtension`，其配置源也只有客户端列表。

影响：不能承诺“终端配置的所有 MCP 与工具都自然出现在 ACP”。用户自行安装的普通扩展仍可加载；这一发现不是说所有用户 MCP 都必然不可用。

建议：明确 Bridge 的 Pi 内置扩展策略，支持 Pi 原生配置源与客户端注入源的合并、命名冲突处理及重复连接去重。先做隔离契约测试，不直接双重注册两个 MCP 实例。同步增加工具/服务器状态诊断。

## 二、数据与运维体验的高优先级设计问题

### B1 / P1：客户端“完成”可能永久删除 Pi 原生历史【源码和现有兼容性文档确认；不是协议违规】

`session/delete` 最终调用 `SessionIndex.delete()`，直接删除 Pi JSONL。现有 Air 兼容性文档记录，某些 Air in IDEs 版本会在“完成”流程触发此接口。Bridge 又会列出并管理非 Bridge 创建的 Pi 原生历史。

ACP [删除语义][protocol-delete] 明确允许 soft delete 或 hard delete，只要求不再出现在列表。永久删除是当前实现的产品选择，而不是协议强制。

建议：优先考虑 tombstone/归档或可恢复删除，并明确其对原生 Pi CLI 的可见性；另提供显式永久删除入口。变更前需用户决策、迁移设计和直接相关测试，不能在本轮静默改变既有语义。

### B2 / P1：诊断无法清楚回答“当前到底运行了什么”【源码确认】

当前 agentInfo 版本来自固定 package version；`/session` 没有完整展示 build identity、实际入口、Node/Pi SDK 版本、agentDir、配置来源和模型刷新结果。用户遇到旧进程、不同 profile 或 GUI 环境差异时容易反复 reload/重启。

建议新增只读 `/doctor` 或扩展 `/session`：展示运行时/构建指纹、启动路径、profile 与模型配置来源、默认/当前/scope 三者关系、最近刷新结果、MCP 状态；只报告凭证来源/状态，不输出凭证值。

**更正上一轮说明**：当前 `scripts/create-local-registry.mjs:34-37` 打包的是启动器，启动器指向本仓库的 `dist/index.js`，并不是 bundle 副本。通常 rebuild + 真正重启 agent 即可；更换 Node/仓库路径或启动器配置时才需要更新注册物。不能把“安装包副本没更新”当成该脚本当前架构的默认解释。

### B3 / P2：历史列表/恢复和发送队列缺少规模预算【待验证风险】

- `SessionCatalog.scan()` 每次查询扫描全部原生历史，再排序分页；分页不减少首次扫描成本。
- `replayHistory()` 取完整分支，图片恢复逐项处理/落盘。
- 工具 Diff 对文件执行同步全量 `readFileSync()`，没有大小预算；不同会话共用事件循环。
- prompt 通知队列没有合并/容量控制，客户端较慢时可能持续积压。

不能仅凭这些路径断言日常已经慢，也不能给出未经测量的耗时。建议针对历史条目数、文件大小、慢客户端分别做轻量定向测量，再决定缓存、预算、批处理或受控背压；不要先引入重型数据库/服务。

## 三、值得投入的大功能

| 功能 | 当前差距及体验影响 | 对标证据 | 建议 |
| --- | --- | --- | --- |
| **IDE 文件系统适配** | 不调用客户端 fs；Pi 工具读的是磁盘。未保存编辑器内容除非客户端主动附带，否则不可靠可见，写入也可能与编辑器缓冲区冲突 | [ACP 文件系统][protocol-fs]；[Gemini AcpFileSystemService][gemini-fs] | P1/P2。先按 capability 路由 read；再统一 edit/write 与 Diff 快照来源。不能仅替换 write 而让 edit 仍基于旧磁盘快照 |
| **权限、只读与 Plan 模式** | 当前工具直接执行，Diff 不是审批。旧式 mode 被用于 Thinking，不是安全模式 | Claude/Codex README；Gemini `requestPermission` 路径 | P2；若用于非完全可信项目则前置。需要工具执行前拦截、拒绝/取消 fail-closed、权限状态管理。仅给 read/write 加确认不能约束 bash；Plan 必须真的禁止变更 |
| **会话分叉 / 从某点继续** | 当前只能恢复同一分支，不能方便比较方案或重试路径 | [Codex SessionFork][codex-fork]；Claude fork-session；Pi AgentSessionRuntime 已提供 fork 能力 | P2，高用户价值。先定义源会话并发、分支历史和 ID/租约规则；分叉不是撤销文件修改，不应暗示自动回滚 |
| **认证引导与失效恢复** | `authMethods: []`，需要离开 IDE 去终端；空模型列表缺少清晰自救路径 | Codex 初始化 auth methods 和 login 流程 | P2。先提供原因/来源/重新验证与正确 profile 提示，再集成 ACP 认证；禁止复制个人凭证作为快捷修复 |
| **MCP 状态与定向重连** | 不提供明确的“哪些 server 已连接、失败原因、如何重连”入口 | [Codex McpStartupTracker][codex-mcp]；Claude `/mcp` | P2，比单纯增加更多 transport 更实用。重连要支持取消/结束结算和重命名冲突 |
| **长命令与后台任务** | bash 只有普通工具结果，不提供完整交互终端/后台任务生命周期 UI | Claude interactive/background terminals；Codex negotiated async tasks | P2/P3。先做长命令可见性和精准停止，再考虑终端交接；取决于 Pi 工具和客户端能力，不是加一个 ACP 字段就完成 |
| **结构化 Plan / 子代理活动** | 无标准 plan 更新和独立子代理会话映射 | Claude/Codex 已有 plan、协商式子代理 | P3，除非现有 Pi 扩展已经稳定输出结构化事件。不要通过解析自由文本伪造计划或父子关系 |
| **生成中追加指令（steer/follow-up）** | 同会话 busy 一律拒绝；Pi SDK 本身有 steer/followUp | SDK 文档；Claude steering 是 v1 扩展，v2 当前仍有差异 | P2/P3。先确定 Air 实际支持的入口，清晰区分 steer 和下一轮队列，不直接取消后重发 |
| **额外工作目录** | 显式拒绝 additionalDirectories | Claude/Codex 支持多目录 | P2/P3，适合 monorepo/跨仓库；明确它不是文件系统沙箱边界 |

这些缺口并不全是 bug。权限和文件系统委托属于 IDE 场景的重要产品能力，分叉属于增量能力，子代理/后台任务则还受底层 Pi 语义制约。**不建议将 Bridge 重写成 Codex 的 App Server 架构**：Pi SDK 已在进程内提供多数基础能力，只需把必要的协议与生命周期边界补全。

## 四、其他源码确认的体验问题

- **扩展内改变模型后，配置 UI 可能滞后**：配置发布只发生在 Bridge 指定入口，不会在每个普通扩展命令结束后比较模型/Thinking 快照；metadata listener 只处理标题。可在提示结算时按变化发布，避免每个 delta 重发。需要增加定向测试后再决定同步范围。
- **上下文来源信息丢失**：`src/content.ts:26-27` 把普通 resource link 降为 Markdown，把嵌入文本资源只取正文。路径/URI/片段来源没有统一保留；模型可能不知道两段代码来自哪里。应保留明确来源封装，但不要自动抓取任意远端 URI。
- **恢复后的工具呈现缩水**：`replayHistory()` 的工具调用没有 live 时的 kind/locations/Diff 映射；不应为了重建历史 Diff 再执行工具或读取当前文件伪造旧状态。可复用安全的名称/参数映射，历史 Diff 需要持久化真实变更事实才可还原。
- **关闭可能无限等待第三方代码**：当前 close/shutdown 等待 prompt、配置切换和扩展 shutdown；这是现有文档已知约束。建议先提供阶段诊断和取消状态，不以粗暴超时 dispose 制造后台仍写文件的假关闭。进程级强制退出与数据风险要单独设计。
- **协议文档需跟随上一轮修复更新**：`docs/protocol.md` 的 Thinking 后缀、reload 范围描述与新实现需明确区分“新会话启动”和“已有会话模型切换”；README 更新不能代替维护协议文档。

## 五、建议执行顺序

### 阶段 1：可靠性收口

1. A4 错误脱敏边界及 A5 统一诊断。
2. A1 模型失效后的原会话恢复。
3. A2 取消与工具终态收尾。
4. A3 扩展自定义消息实时/回放一致性。
5. B2 运行时/profile/build 诊断。
6. B1 删除语义决策；A6 Pi 原生与客户端 MCP 合并策略。

每项以一组最小失败用例和定向测试落地，不触发全量陪跑。

### 阶段 2：IDE 体验

编辑器 fs、上下文来源、MCP 状态/重连、配置变化同步，然后做目标 Air 版本的少量人工主干验收：模型失效切换、工具中途取消、未保存文件、扩展输出恢复。

### 阶段 3：功能扩展

已按用户选择实现会话内可选审批/Plan、当前分支末尾分叉与 steering；默认直接执行，不修改全局设置。终端/后台任务与指定消息位置分叉不在本轮范围，ACP v2 仍按草案跟踪。使用既有 SDK 可选能力和广告过的 v1 扩展，不向普通 ACP v1 注入未协商的 AIR 后台协议；详见 [第三批依据与边界](acp-session-controls.md)。

## 六、复现与验证记录

临时证据文件：`.scratch/acp-research/audit.test.ts`。

```sh
pnpm exec vitest run .scratch/acp-research/audit.test.ts
```

最终结果：4/4 通过，约 309ms（含导入）。这些测试是**当前缺口的特征测试**：通过表示复现了现有问题，不表示修复完成。覆盖 A1、A2、A3 的消息回放、A4 的 URL token。

初次运行中取消测试的检查命令误用了需要额外 fixture 的 `/session`，导致测试超时；改为无该依赖的 `/name` 顺序哨兵后通过。该超时不计为产品故障。没有发起真实模型请求、启动浏览器/容器、运行全量回归或修改个人配置；测试结束无需保留服务进程。

补充：当前工作树原有 `scripts/create-local-registry.mjs:16` 包含 `accessSync(icon);h`，其中游离的 `h` 会在该路径报 `ReferenceError`；这是本轮开始前已有的未提交修改，不是上游基线缺陷。本轮未改动它，也未运行注册脚本。

## 来源

[claude]: https://github.com/agentclientprotocol/claude-agent-acp/tree/0ce42f2c312d190f78024d8b4b1ae5f00d9e5939
[codex]: https://github.com/agentclientprotocol/codex-acp/tree/582e545eb1868763645ea59b1a2c106e50d5d471
[gemini]: https://github.com/google-gemini/gemini-cli/tree/363a13119a57354f469732577518b9d6b319d1d6/packages/cli/src/acp
[protocol]: https://github.com/agentclientprotocol/agent-client-protocol/tree/c3790ac34421633c3c1cdbbdff964b647270cec9/docs/protocol/v1
[claude-agent]: https://github.com/agentclientprotocol/claude-agent-acp/blob/0ce42f2c312d190f78024d8b4b1ae5f00d9e5939/src/acp-agent.ts
[claude-failure]: https://github.com/agentclientprotocol/claude-agent-acp/blob/0ce42f2c312d190f78024d8b4b1ae5f00d9e5939/src/session-failure-extension.ts
[codex-errors]: https://github.com/agentclientprotocol/codex-acp/blob/582e545eb1868763645ea59b1a2c106e50d5d471/src/CodexErrorExplanations.ts
[codex-fork]: https://github.com/agentclientprotocol/codex-acp/blob/582e545eb1868763645ea59b1a2c106e50d5d471/src/SessionFork.ts
[codex-mcp]: https://github.com/agentclientprotocol/codex-acp/blob/582e545eb1868763645ea59b1a2c106e50d5d471/src/mcp/McpStartupTracker.ts
[gemini-fs]: https://github.com/google-gemini/gemini-cli/blob/363a13119a57354f469732577518b9d6b319d1d6/packages/cli/src/acp/acpFileSystemService.ts
[protocol-fs]: https://github.com/agentclientprotocol/agent-client-protocol/blob/c3790ac34421633c3c1cdbbdff964b647270cec9/docs/protocol/v1/file-system.mdx
[protocol-delete]: https://github.com/agentclientprotocol/agent-client-protocol/blob/c3790ac34421633c3c1cdbbdff964b647270cec9/docs/protocol/v1/session-delete.mdx
