# JetBrains Air 本机集成

对应工单：#7。真实 IDE 的流式聊天、原生 Diff 和模型选择必须人工验收；协议测试不能替代界面结果。

## 构建与注册

1. 确认本地 `node_modules` 已准备好，然后 `pnpm run build`。生成约 8 MB 的压缩单文件 `dist/index.js`，包含 `#!/usr/bin/env node`，可通过 Node 22.19+ 启动。
2. 编辑 `~/Library/Application Support/JetBrains/Air/acp.json`，在现有 `agent_servers` 下**追加**条目，不替换已有配置：

   ```json
   "Pi-Bridge (Dev)": {
     "command": "/absolute/path/to/mise/installs/node/22.22.0/bin/node",
     "args": ["/absolute/path/to/pi_acp_bridge/dist/index.js"],
     "env": {}
   }
   ```

   使用 `mise where node@22.22.0` 确认实际运行时路径，不依赖 GUI 进程的 shell PATH。Node 升级或仓库搬迁后需要更新这些绝对路径。不要把密钥复制进仓库文档或配置示例。
3. 刷新代理列表或重启 Air，选择 **Pi-Bridge (Dev)**，以可信工作区新建聊天。工作区应由 IDE 通过 ACP `cwd` 传入，不在命令中硬编码。
4. 默认使用 Pi agent 目录和已有凭据；如必须指定其他配置目录，可在 `env` 中配置 `PI_CODING_AGENT_DIR`。GUI 不一定继承终端中的 API key 环境变量。桥接器不实现 ACP 登录，应事先在 Pi 中完成认证。

本次本机配置保留原有 `Pi` 条目，备份位于项目 `.scratch/issue-7/acp.before.json`（不进入 Git）。回滚时先确认备份之后没有其他配置变动，避免覆盖后续修改。

## 人工烟测

只在可信、允许实际文件变更的工作区执行；建议使用 `.scratch/` 下可丢弃的文件。工具会实际执行，不等待 IDE 的确认，也不会因关闭 Diff 或取消提示自动回滚。

| 场景 | 操作 | 通过条件 | 本次状态 |
| --- | --- | --- | --- |
| 握手 | 选择代理并新建聊天 | 无连接/协议错误，会话可用 | 待人工确认 |
| 流式回复 | 发送“请分三段介绍你自己” | 文本逐步出现，最终正常结束 | 待人工确认 |
| 原生 Diff | 让代理创建草稿文件，再用 edit 或 write 修改其中一行 | Air 原生并排或行内 Diff 显示真实 old/new 内容 | 待人工确认 |
| 模型切换 | 在下拉框选择另一个已有凭据的模型，完成后再发消息 | 选择保留，后续提示成功；不是仅出现模型名 | 待人工确认 |

模型下拉框通过 ACP `configOptions` 广告，并用 `session/set_config_option` 切换；它不是初始化 `_meta` 扩展。列表只展示 Pi 判定已配置认证的可用模型，不展示完整内置目录；同一已认证提供商仍可能包含多个可选模型。认证来自 Pi 的可用性快照，不保证远端凭据永远有效。在 Pi 中新增认证后，应重连或新建 Air 会话以刷新列表。正在生成时切换返回 busy，应等提示结束或取消后再切换。模型变化只属于当前会话，不修改 Pi 全局默认值。

若 Diff 未出现，确认工具为 `edit` 或 `write` 且真的改变了文件；bash 任意文件变更不在当前 Diff 捕获范围内。若无法连接，检查绝对路径、构建产物和 Air 日志；不要向桥接器 stdout 添加诊断输出，因为该流只用于 ACP。

## 内置命令与长上下文

重建 bundle 后，需要让 IDE **重新启动代理进程**（例如断开后重连，必要时重启 IDE）才能加载新代码。已运行的旧进程不会因为替换 `dist/index.js` 或执行 `/reload` 而升级；不必删除聊天或修改认证。

- `/session`：查看当前模型、Pi 历史路径、累计用量和可用的上下文占用估计，不调用模型。
- `/reload`：重载资源并刷新命令/模型选项，保留当前上下文；客户端 MCP 会重连。不负责 IDE ↔ 终端的历史交接。
- `/compact` 或 `/compact 保留项目约束、尚未完成的任务和关键路径`：主动压缩，通常调用模型并产生费用。可以取消；压缩时同一会话不能再发消息或切换模型。
- 上下文超限时，Pi 的自动压缩、重试状态现在有文字反馈。是否启用自动压缩仍遵循用户的 Pi 设置，桥接器不改写全局设置。
- 恢复聊天时展示 JSONL 当前分支的完整消息，而非只有压缩后留给模型的消息。此修复需要 IDE 真正调用 `session/load`；仅打开缓存页面不会强制刷新。

以上已通过本地协议/真实 SDK 加假模型测试；当前 Air、CLion 的命令菜单刷新、取消按钮和新工具图片导航仍需实际界面验收。

## Air in IDEs：Thinking、表单和标题

2026-10-17：用户当前使用 CLion / PyCharm 的 **Air in IDEs**，不是独立 Air 或旧 AI Assistant。该插件读取 `~/.jetbrains/acp.json`；本机已注册的 **Pi-Bridge** 直接运行本仓库 `dist/index.js`。注册表代理 **pi ACP** 是另一实现，不能用其旧聊天、菜单或元信息验证本桥接器。

本轮不另造斜杠指令，补齐 Pi 原有 `/name` 的兼容支持；文件与命令执行仍交给 Pi。重新启动代理进程后验证：

1. reasoning 模型出现 Thinking 配置；切换非 reasoning 模型后隐藏，档位由当前模型决定。
2. 使用已配置的扩展触发 Pi `select/input/confirm/editor`：应出现客户端原生表单，提交后继续原轮次，取消不能视作确认。桥接器不注册额外问答工具，也不针对插件猜测控件类型；Pi 传来 input 就呈现输入框，不自动转换成多选。程序仅在客户端声明 `elicitation.form` 时请求表单，不提供文字回答命令。
3. Pi 已有标题及扩展产生的标题变更应通过 `session_info_update` 同步；重新加载仍保留。可用 Pi 原有 `/name <标题>` 改名、`/name` 查询；未实现 IDE 原生改名动作反向写回 Pi。

这些功能已通过本地协议及独立 bundle 验证，但 **Air in IDEs 的具体控件外观和展示行为仍待人工验收**。不以旧 AI Assistant 的能力或协议成功代替本插件界面证据；第三方自定义 TUI 工具也不会自动变成表单。

## 暂不实现：手动交接历史

用户于 2026-10-17 明确暂不做交接。保留既有 `/reload`，不添加交接指令、暂停/恢复状态或磁盘历史刷新。用户观察执行 reload 后能接续的现象留待验证，不将资源重载宣称为历史重开。不要同时在两端写入同一 JSONL。

## Air 注入的 MCP

Air 的实际聊天会向 `session/new` 注入 MCP 服务，即使它探测模型列表时传入的是空列表。桥接器现支持这些 stdio / Streamable HTTP 配置：由 Pi 官方 MCP 扩展发现并执行工具，直接提供给模型；配置不写回全局文件。恢复会话采用新客户端的 MCP 参数，关闭/断线释放连接，SIGTERM/SIGINT 也先清理 MCP 子进程再退出。

只有真实 MCP 工具调用成功才证明端到端连接正常；列表探测成功或会话创建成功本身不证明这一点。旧式 SSE、ACP 内嵌 MCP 和 MCP OAuth 界面不在当前支持范围。

## 已定位的集成故障

- 生成图片后聊天正文出现大段 Base64 / `resource_link` JSON：Air 将非文本助手块序列化展示，未渲染成附件。此前改为正文 Markdown“打开图片”绝对文件链接和可复制路径，用户已确认链接能打开文件。本轮按用户选择改为工具结果优先：保留原生工具图片，在同一结果附上文件链接、路径和 ACP 文件导航，不再额外插入同一图片的助手正文。恢复历史同样处理。新版工具导航仍待界面验收；此前诊断代理的工具文件打开不等于新版已验收。模型随后输出的 `![名称](/绝对路径)` 仍导致点击报错，现增加实时及历史文本转换：本地行内图片标记统一变为普通 `file:///` 链接，相对路径以会话 cwd 解析。模型链接转换的真实 Air 点击行为仍待验收，不宣称已支持正文内嵌预览。检查本机 Air 的 `fleet.plugins.ai.frontend.jar` 后确认：`AcpAgentFrontendKt.handleAgentMessageChunk` 仅对 `ContentBlock.Text` 提取正文，其他类型使用 `Json.encodeToString` 转成字符串；当前这条 ACP 助手消息路径没有原生图片渲染分支。

- 图片提示返回“大小限制”，但原图仅约 912 KiB、1254×1254：Pi 在 Photon 加载失败时也返回 `[Image omitted: could not be resized below the inline image size limit.]`。生产构建现将 Photon WASM 压缩内嵌，避免依赖 bundle 外的文件；SDK 的 resize worker 不存在时使用官方进程内回退。独立 bundle 图片处理回归通过，并用该原图完成无模型请求验证。macOS 浮动截图拖入后、ACP 提示尚未到达的卡住问题尚未确认解决。

- OpenAI OAuth 模型可展示、可选择，但提示返回统一错误：会话 JSONL 中实际为 `OAuth auth derivation failed ... Cannot find module .../dist/openai-chatgpt.js`。Pi 的 OAuth loader 使用变量动态导入，单文件构建无法自动收集模块；CLI 现注册 Pi 官方静态 OAuth loaders（导出名为 `registerBunOAuthFlows`，同样适用于 Node）。bundle 回归用临时假凭据实际执行 `ModelRuntime.getAuth('openai')`，禁止网络与外部模块加载，不接触用户认证。

- 单文件构建必须定义 `PI_BUNDLED_NODE=true`。Pi SDK 据此使用内嵌虚拟模块和 `jiti/static` 加载扩展；否则初始化仍成功，但文件型扩展会因 `Cannot find module 'typebox'` 全部失效，扩展提供商（例如 `pi-antigravity`）也会从模型下拉框消失。不能仅用初始化握手证明生产 bundle 支持 Pi 配置。
- Air 日志出现 `Cannot insert duplicate value AgentId(...)`，随后出现 `Failed to obtain agent frontend provider` 时，提交动作会在 IDE 前端失败，桥接器收不到 `session/prompt`。这不证明用户选错代理，也不证明模型服务未响应。可在用户授权后换一个临时代理名称验证是否能绕开该注册状态，不应擅自清空聊天或缓存。本次诊断暂用 `Pi-Bridge (Check)`，保留脱敏跟踪入口；后续用户已确认真实聊天恢复正常。
- Air 可成功显示用户消息但随后立即报错：若跟踪显示 `session/new` 的 `mcpCount: 1`，旧版本会因拒绝客户端 MCP 返回 `-32602`，尚未调用模型。现通过真实接入修复，不静默丢弃 MCP 参数。
- Pi 的默认提供商与认证提供商是不同配置。如果旧设置指定 `openai-codex/gpt-5.5`，但认证仅属于 `openai`，SDK 可能回退到 `openai/gpt-5.5`。桥接器不自动迁移、复制认证或改写用户默认设置。

## 自动化证据

- `pnpm run build`：生成压缩 bundle，保留可执行 shebang。
- `pnpm exec vitest run test/bundle.test.ts`：真实子进程握手及创建会话，禁止外部模块加载；验证文件型 TypeScript 扩展可导入 TypeBox、注册命令与提供商，并出现在模型选择器中，无模型网络请求。
- `pnpm exec vitest run test/models.test.ts`：真实 Pi 会话经 ACP 切换，确定性模型流证明下一次提示使用新模型，其他会话不变。
- `test/mcp.test.ts`：本地 stdio / HTTP MCP 实际工具调用、字面凭据传递、恢复会话更新配置、关闭/断线清理。bundle 测试额外验证 SIGTERM 后 MCP 子进程退出。
- `test/persistence.test.ts`：恢复会话继续提供模型配置；`test/sessions.test.ts`：活动提示期间拒绝切换。

以上自动化证据不能替代界面验收。真实聊天与旧版图片文件链接已有用户反馈；原生 Diff、实际模型切换以及本轮新增交互仍待人工确认，不能据此宣称 #7 全部完成。
