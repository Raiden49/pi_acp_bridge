# 协议与维护约束

## 支持范围

ACP v1，通过 stdio NDJSON 通信。Pi SDK 在进程内运行，每个会话具有独立工作区上下文；不使用 `process.chdir()`。工作区不是文件系统沙箱；工具默认直接执行，可通过会话内 Tool policy 选择审批或 Plan，不能隔离恶意扩展。

| 接口 | 行为 |
| --- | --- |
| `initialize` | 返回支持的协议版本、代理版本、图片/嵌入文本、会话恢复/关闭/删除/末尾分叉、stdio 与 HTTP MCP 能力，以及可选 steering 扩展 |
| `session/new` | 要求现有目录的绝对 cwd，创建独立 Pi 会话 |
| `session/list` | 查询 Pi 原生历史，按绝对 cwd 过滤、更新时间倒序，每页 50 条；不限于 Bridge 创建的会话 |
| `session/load` | 恢复索引或 Pi 原生 ID 对应的同一 cwd 会话，回放当前分支完整历史，不重新执行工具 |
| `session/prompt` | 流式发送文本、思考与工具事件，排空通知队列后返回结果 |
| `session/fork` | SDK 实验性接口；复制空闲持久化会话当前分支到新 ID/JSONL，不替换源会话、不回滚文件；明确拒绝指定消息位置 |
| `_session/steering` | 可选 v1 扩展；由 `_meta.steering.supported` 广告，运行中接入 Pi 输入管线，空闲支持 promptRequired 或兼容性启动提示 |
| `session/set_config_option` | 切换会话模型、Thinking 或 `approval` 工具策略 |
| `session/set_mode` | 广告的模式为 direct/ask/plan 工具策略；旧 Thinking 值保留兼容入口 |
| `session/cancel` | 中止活动提示，保留会话及已产生的历史和文件变更 |
| `session/close` | 清理资源，不删除历史 |
| `session/delete` | 清理资源后永久删除已知会话的 Pi JSONL 与桥接索引项；目标已不存在时幂等成功 |

不支持 ACP 登录、额外工作目录、指定消息位置分叉、终端交接、独立后台任务、SSE MCP 或 ACP 原生 MCP OAuth UI。`authenticate` 返回 `-32601`；Pi `/mcp` 提供的本机 OAuth 流程由 SDK 管理，不代表客户端实现了 OAuth elicitation。

## 分叉、追加输入与工具策略

- `session/fork` 使用独立 Pi `SessionManager.createBranchedSession()` 与新会话租约；源提示/配置变更、分叉/load/delete 互斥，无对话历史时拒绝。不调用替换源 runtime 的 fork，不自动重放消息；需要回放时 load 新 ID。
- `_session/steering` 参考 Claude ACP v1 契约，不影响普通 session/prompt 的 busy 规则。运行时采用 Pi RPC 的公开 prompt/preflight 机制，异步输入计入当前 ACP 提示并等待结算；消费时点依 Pi 的工具/模型边界，不中断已执行的工具。取消/本地命令/结算中拒绝追加；迟到 input 不能复活取消的提示。
- 空闲且 `_meta.steering.idleBehavior: "promptRequired"` 时返回 `{ outcome: "promptRequired", reason: "noRunningTurn" }`，不解码附件或启动模型；未指定时兼容返回 startedNewTurn，启动普通提示并管理异步失败与清理。
- `configOptions` 的 `approval` 可选 direct（默认）、ask（逐次批准可能变更的工具）、plan（只允许 read/grep/find/ls、codemode 容器与 tool_search）。Plan 阻止所有 shell、edit/write、MCP 和未知工具；嵌套调用走相同 Pi `tool_call` 拦截，不依靠提示词或 shell 文本猜测。
- 审批先发布对应工具，再发标准 `session/request_permission`，仅提供 allow_once/reject_once；取消、拒绝、RPC 失败或迟到批准不能放行，不保存永久授权。SDK cancellationSignal 负责通知客户端，额外本地 abort race 避免客户端不回应时挂住提示。
- 策略保存在原生分支 custom entry；索引 approvalMode 为尚未落盘/setup-only 会话的恢复后备，避免空白 Plan 会话关闭恢复后降级。原生分支记录优先，分叉继承；不修改 Pi 全局设置。未加载执行拦截器时不广告策略选项。
- 可信扩展可运行任意宿主代码和替换同名工具，因此不是 OS/插件安全沙箱；Plan 只约束正常 Pi 工具管线。取消不撤销已发生的变更。旧式 `modes` 与 `approval` 工具策略保持一致；旧客户端缓存的 Thinking mode ID 仍兼容处理，但不再广告为工作模式。

依据、完整边界和测试见 [第三批实现对标](acp-session-controls.md)。实际 IDE 入口、选择器与审批 UI 尚须人工验收。

## 模型与 Thinking

- 标准下拉框来自 new/load 的 `configOptions`。模型 ID 为 `provider/id`，显示标签为 `model_name (provider)`，使用 Pi 提供的显示名称（Air in IDEs 拒绝与 ID 完全相同的名称），仅选取 Pi 认证可用快照中的模型；快照不保证远端调用成功。
- Pi 合并设置中的 `enabledModels` 限制选择范围，复用 SDK 的匹配、顺序与去重规则。空范围展示全部可用模型；范围外但仍可用的当前模型追加保留；无匹配时警告且不放宽到全量。筛选本身不刷新认证或访问网络。
- 没有消息的新会话按 CLI 范围启动：保存的默认模型在范围内时优先，否则使用第一个匹配模型，并应用该项显式 Thinking 后缀；无匹配时保留 SDK 默认/fallback，不放宽范围。成功恢复已有模型时不套用新默认；SDK 明确报告恢复失败时，重新按 CLI 范围规则选择，而不是保留其忽略 scope 的 fallback。模型或 Thinking 切换只影响当前会话，不修改全局默认；Pi `/model` 的 Ctrl+S 才保存启动默认。
- reasoning 模型仅通过 `thought_level` 配置广告档位，直接使用 Pi 当前模型的能力，不硬编码供应商/模型名称。`modes` 只广告已加载执行适配的工具策略；`current_mode_update` 表示工具策略，不再广播 Thinking。模型切换后 `config_option_update` 携带完整配置与新档位列表。每轮提示结算时还比较完整配置快照，扩展改变模型/Thinking/目录可用性后按变化发布；无变化不重复发送，不按 delta 广播。失败/取消结算仍可同步配置元数据，但关闭的会话不再发布。
- 当前模型缺失、不可用或在范围外时，保留明确标注的诊断项和其他可选模型。诊断展示不加入可选集合，设置模型时仍拒绝范围外值；scope 无匹配时不扩大集合。成功恢复的历史模型不会因此自动切换，也不伪造认证可用性。`__pi_no_model__` 仅是“未选择模型”占位，不是可调用模型；当前模型声明支持 reasoning 且提供档位时保留 Thinking 选项；模型诊断项不因此变成可调用模型。
- `initialize._meta["pi-acp-bridge/models"]` 是独立的完整发现目录，内容仅有 ID 与名称，不过滤认证，不填充 IDE 下拉框。发现过程不联网、不解析秘密命令、不写认证；无效配置返回脱敏错误。

## 命令与表单

| 命令 | 行为 |
| --- | --- |
| `/session` | 显示会话、历史路径、模型、用量和上下文估计，不请求模型 |
| `/doctor` | 只读诊断运行构建指纹、SDK/Node、profile/路径、模型范围/刷新、配置来源与 MCP 入口，不请求模型 |
| `/name [标题]` | 查询或设置 Pi 标题；Pi → IDE 单向同步，不实现 IDE 改名反写 |
| `/reload` | 由 SDK 重载设置与扩展；使用其 `beforeSessionStart` 在 provider 注册完成、MCP 启动前本地刷新模型能力并发布变化的配置；最后发布命令与配置。保留模型 ID、兼容的 Thinking 和历史，不联网拉目录、不加载新版 Bridge 或外部历史 |
| `/compact [摘要要求]` | 调用 Pi 压缩，通常产生模型费用，支持取消 |

命令还包括 Pi 实际加载的扩展、模板与已启用技能。桥接内置命令只从直接文本读取命令及参数，不从嵌入文档触发；执行内置命令时忽略附带的编辑器资源、链接和图片，不读取或解码附件；同一文本块中由空行及 `context: renderer=` 引出的 Air/CLion 上下文后缀不参与命令参数解析。普通额外文本仍按原有参数规则处理，错误消息包含具体用法提示。

客户端注入的 MCP 问答工具实际激活后，提示模型优先使用该工具；未提供、未激活或失败时保留其他问答入口，不伪造表单支持。客户端声明 `elicitation.form` 后，Pi select/input/editor/confirm 映射为原生表单。允许空字符串，editor 保留默认值，拒绝或取消不视为批准。不注册问答工具、不解析文案猜测多选、不提供文字回答命令或自定义 TUI。表单仅服务活动提示；取消、关闭或断线会结束等待，忽略迟到答案。

## 原生 MCP 与扩展

- 与 Pi CLI 一样显式注入具名、可替换的 `codemode`、`tool-search`、`mcp` 内置扩展，遵守 Pi `builtin:` 禁用/替换配置；不重复注册用户扩展。资源加载器和会话共用同一 settings manager。
- 客户端服务器只经公开 `registerMcpServer()` 注入；配置、连接、OAuth、重连和 shutdown 交给 SDK `createMcpExtension()`，不另写 transport/config loader。用户和可信项目的 Pi 原生配置优先于同命名空间的 IDE 注入（包括名称归一化冲突）。
- ACP env/header 值保持 literal，不展开 `${…}` 或执行 `!command`；原生 Pi 配置仍遵循 Pi 的模板/命令语义。stdio/HTTP 对应 SDK 服务器格式；SSE 明确拒绝。
- `/mcp` 查看状态、来源/覆盖关系；`/mcp reconnect <原始服务器名>` 交给 Pi 定向重连，不重启其他服务器。工具 exposure、codemode 和 tool_search 由原生配置决定；“已连接”不等于每个工具都直接展示给模型。
- 仅 `display: true` 的自定义扩展消息映射为助手文本/图片链接；实时输出和完整历史回放共用映射。`display: false` 不向客户端展示，回放不会重跑扩展。

## 编辑器文件系统与来源

- 客户端必须同时声明 `fs.readTextFile` 与 `fs.writeTextFile`，才启用工作区文本 `read/edit/write` 的编辑器委托；缺少任意一项则保留 Pi 原有磁盘行为，不发送未声明能力的 RPC。这个成对策略是针对 Pi 三个文件工具的一致性适配，不是 ACP 的强制规则，也不是所有上游的共同做法。
- 路由与 profile 排除参考 Gemini ACP；工具逻辑复用 Pi 公开 `createReadToolDefinition` / `createEditToolDefinition` / `createWriteToolDefinition` 的 operations 接口，不自建替换算法、截断或文件变更锁。用户扩展若注册同名工具，可按 SDK replaceable 语义替换整组 Bridge 适配。
- 委托请求使用当前 ACP session ID、绝对路径和完整文本，offset/limit、BOM/换行处理及匹配规则仍由 Pi 执行。图片经 SDK MIME 检测后从磁盘读取；工作区外、Pi profile 及 bash/grep/find/ls 仍走本地行为。路径路由不是沙箱，不提供 symlink 安全边界。
- 编辑器请求失败直接作为工具错误返回，不静默改读写旧磁盘。write 的预读和成功后的读回仅用于真实 Diff；不可读快照不生成假 Diff，明确缺失文件才用 oldText=null。成功写入不等于编辑器一定保存到磁盘，也不保证与用户同时编辑原子一致；ACP v1 没有 buffer revision/CAS 契约。
- 文本 `resource` 保留 `<context ref="URI" mimeType="…">` 来源封装，`resource_link` 保留 URI、name/title、MIME、description；URI 片段按原引用保留，不猜测私有行号元数据。不自动抓取远端链接；封装不是 prompt-injection 安全边界。
- `/doctor` 显示当前是否加载 Bridge 编辑器委托；客户端未声明成对能力时，不承诺能看到未保存内容。实际 IDE 缓冲区/保存行为须客户端验收。

## 生命周期与持久化

- 不同会话可并发；同会话的提示、压缩、重载和配置变更互斥，busy 返回 `-32600`。参数/未知会话错误返回 `-32602`；运行错误返回脱敏的 `-32603`。操作失败保留具体原因及有限的 Error cause，不序列化任意错误对象、堆栈或原请求；清除非白名单 error data，并脱敏 URL userinfo/query、认证 header 和常见 token 格式。脱敏不是任意文本的完整 DLP；分享 `/doctor` 前仍应检查路径和 provider/model 名称。
- 取消后停止新增内容，但允许已向客户端展示的工具接收真实完成/失败事件；SDK 未报告终态时以 failed 关闭展示，明确“结果未知”，不谎报回滚。先排空 terminal updates 再结束提示；断开/关闭时不继续向已关闭客户端发送。
- 关闭先阻止新操作，取消活动提示，等待提示和配置变更结算，再 shutdown 扩展并 dispose。服务器 shutdown 还等待创建、加载、分叉、删除和已移出活动表的清理操作。
- 删除支持活动或已关闭的索引会话，与加载互斥，并等待已经开始的关闭。JSONL 删除失败返回错误并保留索引；文件已不存在时可清理残留索引，映射也已不存在时返回成功，兼容客户端重复完成同一条目。文件删除与索引替换不是跨文件原子事务，索引落盘失败可重试；不删除生成的图片资产。
- SDK 模型切换不能可靠取消，因此不以超时强制 dispose；上游永不结算时关闭也会等待。
- 索引默认是 Pi agent 目录的 `acp-sessions.json`，映射 ACP ID 到 `{ cwd, sessionFile, pending?, approvalMode? }`。新会话使用 Pi 原生 ID；已有 Bridge ID 保持兼容，列表按规范化文件路径和原生 ID 去重并优先使用已有映射。发现只读 Pi SDK 原生历史，不批量写入索引；恢复或删除原生历史时才建立所需映射。
- 首条用户或助手消息之前沿用 Pi 延迟落盘：索引记录 `pending: true`，可恢复同一 ID，但不创建空 JSONL。未落盘的模型配置和标题仅在当前进程有效；工具策略单独在索引保留恢复后备，避免安全策略静默丢失；开始对话后由 Pi 正常持久化。不展示旧 header/setup-only 历史，不自动删除旧文件；图片会话仍可列出。已开始的历史若丢失则报错，不重建为空会话。
- IDE 的原生 Pi 来源、ACP 来源与旧本地记录由客户端管理。Bridge 内部去重不等于客户端跨来源合并；Air in IDEs 262.8665.497 的列表映射不读取身份别名元数据，仍可能显示多条指向同一历史的条目。
- 索引以 0600 临时文件及原子 rename 写入，损坏数据拒绝覆盖；`<索引>.lock.sqlite` 的事务锁负责跨进程互斥和崩溃释放。**运行时不得删除协调文件**，不承诺网络文件系统锁语义。
- 从旧目录锁版本升级时，先停止所有旧桥接进程；禁止新旧锁机制同时写索引。
- 索引锁只保护映射。Bridge 另用 `acp-session-locks/` 下的 SQLite 独占事务持有历史文件租约：加载前获取，关闭/断线及扩展清理结束后释放；删除也须获取租约。占用时立即返回 `-32600`、`data.reason: "session_active_writer"`。路径别名按 realpath 协调；崩溃由 OS 释放锁，不删除协调文件。
- 租约默认位于 Pi agent 目录；自定义索引时位于索引同级。只有使用同一租约目录的 Bridge 进程互相协调，原版 Pi CLI 1.3.0 和 SDK 1.2.0 不遵守这把锁。终端接管前仍须停止 ACP 代理，返回 ACP 前退出终端并重新加载会话；`/reload` 不同步外部历史。回放使用完整分支，而非压缩后的模型上下文。

## 上下文用量

新建、恢复、配置变更、有效模型消息结束及提示结算（包括重载、取消和错误）时，发送标准 `usage_update`，其 `used` / `size` 优先来自 Pi `getContextUsage()`，不是累计 token。压缩完成后立即刷新；若 Pi 尚无压缩后的用量，使用压缩结果提供的 `estimatedTokensAfter` 作为临时估算，后续有效模型消息会校正。单次提示内相同用量及窗口大小不重复发送。没有有效用量或压缩估算时不发送，不将未知伪装为零；ACP 没有标准未知值或估算标记，客户端此时可能保留上次值。不保证各客户端均展示用量控件。

## 工具与图片

- Pi 执行工具算法；Bridge 在能力允许时注入编辑器 operations，ACP 呈现生命周期、结果、文件导航和 Diff。本地 edit/write 的快照仍在同步事件监听器采集；委托 edit/write 记录实际编辑器读写前后的内容（含客户端格式化），不读取当前磁盘伪造 Diff。不可读快照不伪造 Diff，bash 任意变更不追踪。
- 输入支持内嵌 base64 或可读本地 file URI 图片、文本和嵌入文本资源。无法处理的内容明确拒绝。
- 工具结果保留原生图片，并附加文件链接与导航；助手历史图片以文本链接呈现。本地 Markdown 行内图片转换为 file 链接，远程链接与代码块保持原样。
- 图片按内容哈希保存至 `~/workspace/storage/media/pi-acp-bridge/`，不自动删除，可能包含敏感信息。客户端展示差异见 [兼容性说明](air-integration.md)。

## 开发与构建

使用本地依赖，执行 `pnpm run typecheck` 和直接受改动影响的 `pnpm exec vitest run test/<file>.test.ts`。测试使用隔离资源和假模型，不操作个人认证；协议验证不能替代真实 IDE 验收。

`test/bundle.test.ts` 额外构建并验证独立 CLI、扩展、OAuth、图片解码、真实 codemode sandbox、构建指纹和 MCP 清理。以下打包设置不是冗余兼容代码：

- `PI_BUNDLED_NODE=true`：启用 Pi 内嵌扩展模块加载器。
- 静态 OAuth loaders：避免动态相对导入在 bundle 旁查找缺失模块。
- 内嵌 Photon WASM：使图片处理不依赖外部文件。
- SDK `VERSION`：构建时从被捆绑的 SDK package 读取并固化公开常量，避免运行时向上查到 Bridge 的 package.json。替换特征改变则构建失败；独立包测试核对诊断版本。
- 独立 `codemode-worker.js`：遵循 Pi Node 构建方式，worker 必须自包含、不得引入 `import.meta`/createRequire banner，以支持 SDK data URL 启动。
- `quickjs.wasm` sidecar：主 bundle 从自身旁边读取，不回退依赖开发机 `node_modules`；构建适配检查 SDK loader 特征，升级不匹配时明确失败。
- 保留 `node:` 前缀：防止将 `node:sqlite` 错当外部包。

分发物是同目录的 `dist/index.js`、`dist/codemode-worker.js`、`dist/quickjs.wasm`，不能仅复制入口文件；仍需要 Node 和用户自行配置的扩展资源。不打包认证、历史或本机配置；当前包为 private，不执行 npm 发布。
