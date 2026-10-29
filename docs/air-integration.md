# JetBrains Air 本机集成

对应工单：#7。真实 IDE 的流式聊天、原生 Diff 和模型选择必须人工验收；协议测试不能替代界面结果。

## 构建与注册

1. 确认本地 `node_modules` 已准备好，然后 `pnpm run build`。生成入口 `dist/index.js`（包含 `#!/usr/bin/env node`），以及同目录的 `codemode-worker.js`、`quickjs.wasm`；三者须一起保留。可通过 Node 22.19+ 启动，不依赖开发机的 node_modules 执行 codemode。
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

只在可信、允许实际文件变更的工作区执行；建议使用 `.scratch/` 下可丢弃的文件。默认 direct 策略会实际执行工具，不等待 IDE 确认；可在支持的客户端通过 Tool policy 选择 ask/plan。关闭 Diff 或取消提示都不会自动回滚已发生的修改。

| 场景 | 操作 | 通过条件 | 本次状态 |
| --- | --- | --- | --- |
| 握手 | 选择代理并新建聊天 | 无连接/协议错误，会话可用 | 待人工确认 |
| 流式回复 | 发送“请分三段介绍你自己” | 文本逐步出现，最终正常结束 | 待人工确认 |
| 原生 Diff | 让代理创建草稿文件，再用 edit 或 write 修改其中一行 | Air 原生并排或行内 Diff 显示真实 old/new 内容 | 待人工确认 |
| 模型切换 | 在下拉框选择另一个已有凭据的模型，完成后再发消息 | 选择保留，后续提示成功；不是仅出现模型名 | 待人工确认 |

模型下拉框通过 ACP `configOptions` 广告，并用 `session/set_config_option` 切换；它不是初始化 `_meta` 扩展。列表只展示 Pi 判定已配置认证的可用模型，不展示完整内置目录；同一已认证提供商仍可能包含多个可选模型。认证来自 Pi 的可用性快照，不保证远端凭据永远有效。在 Pi 中新增认证后，应重连或新建 Air 会话以刷新列表。普通模型提示生成期间可切换模型/Thinking；已发出的请求不改变，Pi 在后续 assistant 请求边界应用新配置，同一回答的工具循环后也可能生效。并发配置修改按顺序完成，失败时尽力补发真实配置纠正乐观显示；重载、压缩和取消期间仍可能拒绝修改。模型变化只属于当前会话，不修改 Pi 全局默认值。

若 Diff 未出现，确认工具为 `edit` 或 `write` 且真的改变了文件；bash 任意文件变更不在当前 Diff 捕获范围内。若无法连接，检查绝对路径、构建产物和 Air 日志；不要向桥接器 stdout 添加诊断输出，因为该流只用于 ACP。

## 内置命令与长上下文

重建 bundle 后，需要让 IDE **重新启动代理进程**（例如断开后重连，必要时重启 IDE）才能加载新代码。已运行的旧进程不会因为替换 `dist/index.js` 或执行 `/reload` 而升级；不必删除聊天或修改认证。

- `/session`：查看当前模型、Pi 历史路径、累计用量和可用的上下文占用估计，不调用模型。
- `/reload`：本地刷新模型目录/可用快照并重载资源，更新命令/模型选项，保留当前模型、Thinking 和历史；原生/客户端 MCP 交给 Pi 重连。不拉远端模型目录，不负责 IDE ↔ 终端的历史交接。
- `/doctor`：不调用模型的只读诊断。核对运行构建 SHA-256、Node 路径、SDK、profile、当前/默认模型及刷新状态；重建文件不会改变旧进程已记录的构建指纹。报告含本机路径，分享前检查。
- `/mcp`：Pi 原生状态与来源/覆盖关系；`/mcp reconnect <原始服务器名>` 定向重连，不重启其他服务器。原生配置优先于同命名空间的 IDE 注入。
- 编辑器缓冲区：只有客户端声明成对的 ACP 文本读写能力时，才委托工作区 `read/edit/write`，否则保留磁盘行为；可用 `/doctor` 查看实际是否加载适配。图片、profile、工作区外文件及 bash/grep 等仍读磁盘。不要把“写入编辑器”当作“已保存磁盘”，也不要把委托当成只读或权限审批。此项已验证协议与 SDK，尚未进行目标 Air 版本的未保存文件验收。
- `/compact` 或 `/compact 保留项目约束、尚未完成的任务和关键路径`：主动压缩，通常调用模型并产生费用。可以取消；压缩时同一会话不能再发消息或切换模型。
- 上下文超限时，Pi 的自动压缩、重试状态现在有文字反馈。是否启用自动压缩仍遵循用户的 Pi 设置，桥接器不改写全局设置。
- 恢复聊天时展示 JSONL 当前分支的完整消息，而非只有压缩后留给模型的消息。此修复需要 IDE 真正调用 `session/load`；仅打开缓存页面不会强制刷新。

以上已通过本地协议/真实 SDK 加假模型测试；当前 Air、CLion 的命令菜单刷新、取消按钮和新工具图片导航仍需实际界面验收。

## 第三批会话控制：待客户端人工验收

- Bridge 广告 ACP SDK 的实验性末尾分叉，以及 Claude ACP v1 `_meta.steering.supported`；实际 Air 是否展示入口、发送对应请求，尚未验证。指定消息位置分叉明确拒绝，不默默复制到末尾。
- 现代 `configOptions` 提供 **Tool policy**（direct/ask/plan）；默认 direct，不改 Pi 全局设置。旧式 modes 同步 direct/ask/plan 工具策略；Thinking 档位仅通过 `thought_level` 配置广告，旧客户端缓存的 Thinking mode ID 仍兼容处理。控件缺失不代表已自动启用 Plan。
- ask 在潜在变更前发送标准 ACP 审批；Plan 阻止写入、shell 和未知工具，也覆盖 codemode 嵌套调用。它不是任意扩展代码的安全沙箱。审批失败/拒绝/取消不降级直接执行，取消后迟到允许不能放行。
- `/doctor` 显示实际加载的策略。最小人工验收应覆盖：新建默认 direct；切 Plan 后写入被阻止；切 ask 后批准/拒绝与取消；空白 Plan 会话恢复；末尾分叉源历史不变；生成中追加与空闲 fallback。建议只操作可丢弃文件。

上游依据、适配差异、协议与真实 SDK 的验证范围见 [第三批会话控制](acp-session-controls.md)。终端委托与独立后台任务没有实现，也不广告其 AIR 能力。

Pi 1.4 与运行中配置变更的实现和验证范围见 [配置事务与恢复初始化](acp-live-configuration.md)。本地 bundle 已升级不代表 IDE 的旧进程已升级；需要真正重启 agent，`/reload` 不加载新版 Bridge。

## Air in IDEs：Thinking、表单和标题

安装见 [README](../README.md#connect-your-ide)。Air Desktop、Air in IDEs 和 AI Assistant 是不同客户端；公共目录中的 `pi ACP` 也不是本桥接器。

## 已知客户端差异

| 客户端 / 版本 | 已观察到的行为 |
| --- | --- |
| Air Desktop 262.1037.6 | 原生助手图片显示为 JSON/Base64；工具图片可打开文件，但没有聊天内预览。旧聊天可能缓存模型列表。 |
| CLion 2026.2.3.1 / AI Assistant 262.10968.223 | 原生助手图片不显示；工具图片可在编辑器打开，本地 Markdown 图片不预览。 |
| CLion / Air in IDEs 262.8665.497 | 用户已确认原生行内/并排 Diff；不能据此推断表单、图片或所有配置控件均已验收。 |

这些结论仅针对列出的版本，不代表整个产品或其他 IDE。Zed、PyCharm 的具体界面行为不作未经实测的承诺。

## 常见问题

- **找不到代理或无法连接**：检查配置文件是否属于当前客户端、Node 与 bundle 的绝对路径是否有效。更新代码后重启代理进程；`/reload` 不加载新代码。
- **选择器有 Pi 图标，普通历史行却显示聊天图标**：2026-10-17 本机 CLion（build 262.10968.176）的只读运行时对照确认，Pi Bridge 与公共 `pi ACP` 都有正确的启动目标映射和缓存图标，但代理描述符的 `launchContributions` 为空。历史行仅通过该字段推导目标，退回通用聊天图标；显式传入已有目标 ID 则返回正确 Registry 图标。这是当前客户端查找路径的问题，不是 Bridge 漏传 ACP 图标字段；不通过改代理 ID、清历史或修改 IDE 绕过。完成、未读等状态图标覆盖不属于此问题。
- **当前模型不可用**：下拉框保留诊断项及其他可用模型，可直接切换；也可修复 Pi 配置后 `/reload`。不会自动将旧聊天改成新默认。
- **模型列表太多或没有更新**：在 Pi 的 `/scoped-models` 中选择后按 **Ctrl+S** 保存，再执行桥接器 `/reload`。Air Desktop 上旧聊天下拉框仍可能缓存旧值，已验证的办法是新建 Pi Bridge 聊天并发送 `/session`。后端范围更新不等于界面刷新。
- **模型栏一直显示灰色占位**：Air in IDEs 262.8665.497 会拒绝名称等于模型 ID 的整个配置快照。桥接器已将显示名改为 `model_name (provider)`；升级后重启代理并新建会话验证，不需要清除认证或历史。
- **模型可见但调用失败**：可用列表反映认证配置，不保证远端凭据有效。先在 Pi 中检查认证和默认提供商；不要复制或迁移认证来猜测修复。
- **Air Desktop 日志报 `Failed to set config option mode`**：262.1037.6 可能将旧式 Thinking 选择保存为 `configId: "mode"`；桥接器继续接受旧 Thinking 值并按当前模型校验；direct/ask/plan 值则切换已加载的工具策略。
- **Thinking 选项未更新**：旧版本把 Thinking 同时放进无法动态替换完整列表的 legacy modes。本次改为仅通过 `thought_level` 配置发布模型实际档位；需重启 agent 并重新加载会话，清除旧 modes 广告。无需删除历史或认证。协议回归已验证完整列表替换，实际 IDE 控件仍需验收。
- **表单不出现**：客户端须声明 `elicitation.form`。只支持 Pi 的 select/input/editor/confirm；自定义 TUI 和文案中的“多选”不会自动变成复选框。
- **图片不内嵌显示**：桥接器保留工具原生图片，同时附加文件链接与导航；不保证聊天内预览。图片资产不会自动删除，默认保存在 `~/workspace/storage/media/pi-acp-bridge/`。
- **没有 Diff**：只捕获 `edit` / `write` 的真实文件变化，不追踪 bash 或脚本中的任意改动。
- **“完成”后 Pi 历史消失**：Air in IDEs 262.8665.497 的完成/归档流程会尝试 `session/delete`。桥接器支持该接口后会永久删除对应 Pi JSONL，不只是隐藏 IDE 列表；仅关闭会话不会删除历史。
- **没有收到回复**：先用 `/session` 区分连接问题与模型问题。客户端提交失败时，桥接器可能根本没收到 prompt；不要因此直接删除聊天或缓存。

诊断输出只能写 stderr，stdout 专用于 ACP。图片无响应时，可在代理启动环境临时设置 `PI_ACP_TRACE=1` 并重启代理：`prompt_received` → `prompt_decoded` → `prompt_dispatched` → `prompt_settled` 分别表示收到、解析、交给 Pi/命令处理、结束；解析拒绝会记录 `prompt_rejected`。日志只含时间、会话 ID、数量/长度、阶段与错误码，不含正文、图片内容、文件 URI 或认证。没有 `prompt_received` 只能说明未进入 Bridge 提示处理器，不能据此断定是客户端、传输还是协议校验的问题。排查后关闭该环境变量。

协议测试通过不等于 IDE 界面已验收；真实模型请求可能产生费用。
