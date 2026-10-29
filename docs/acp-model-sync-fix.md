# 模型恢复、Thinking 与 reload 修复

> 本文记录上一批基于 SDK 1.2.0 的修复与验证。后续 Pi 1.4 升级、运行中配置和扩展 provider 恢复顺序见 [配置事务与恢复初始化](acp-live-configuration.md)。

## 对照依据

本次复用已固定 commit 的成熟实现，不将研究时的上游接口直接替换成本项目的 ACP v2：

| 依据 | 实际做法 | Bridge 修复 |
| --- | --- | --- |
| [ACP v1 Session Config Options](https://github.com/agentclientprotocol/agent-client-protocol/blob/c3790ac34421633c3c1cdbbdff964b647270cec9/docs/protocol/v1/session-config-options.mdx) | configOptions 优先；响应及更新携带完整配置，可更换模型相关选项；legacy modes 与工作模式同步 | Thinking 仅广告为 `thought_level`；不再保留另一份无法动态替换的 legacy Thinking 列表。modes 同步已加载的工具策略 |
| [Claude ACP 模型切换](https://github.com/agentclientprotocol/claude-agent-acp/blob/0ce42f2c312d190f78024d8b4b1ae5f00d9e5939/src/acp-agent.ts#L11019-L11075) | 模型变化后重建 effort 配置，使用新模型支持的档位 | 继续调用 Pi `getAvailableThinkingLevels()`，发布完整配置；不硬编码 DeepSeek/provider 特例 |
| [Codex ACP ModelConfigOption](https://github.com/agentclientprotocol/codex-acp/blob/582e545eb1868763645ea59b1a2c106e50d5d471/src/ModelConfigOption.ts) | 保留当前模型的展示；reasoning 选项来自支持能力，独立于权限模式 | 保留缺失/范围外当前值的诊断项，但不把它加入 `selectableModels()`，模型 setter 仍拒绝范围外值 |
| 安装的 Pi SDK 1.2.0：公开 `resolveModelScopeWithDiagnostics`、`AgentSession.reload({ beforeSessionStart })`、`SettingsManager`、`VERSION` | SDK 历史恢复失败的 fallback 调用使用空 scopedModels；reload 在关闭旧扩展后读取设置、重建 provider，再调用 beforeSessionStart，随后发 session_start 启动 MCP | 只有恢复失败时重新应用既有 CLI 范围选择；在正式钩子刷新模型能力与发布配置，不自造 MCP 生命周期 |

## 已修复的边界

- **当前展示不等于允许选择**：历史模型成功恢复但不在新 scope 中时，保持实际会话选择，明确标为诊断项；不会因展示它而扩大可选集合。scope 无匹配时不自动放宽。`enabledModels` 是模型选择范围，不是扩展/宿主代码的安全沙箱。
- **恢复与 fallback 分开**：成功恢复的历史模型不套用新默认；SDK 明确报告恢复失败时，按已存在的 CLI scope 逻辑重新选择。启动诊断标记为历史事件，同时记录 Bridge 实际启动选择，避免旧 fallback 被误读为当前模型。
- **Thinking 单一广告来源**：现代配置使用模型真实能力；旧 Thinking mode ID 保留调用兼容，但不再广告到工作模式列表。direct/ask/plan 的 modes 与工具策略一致，不能靠调整 Thinking 改变审批。
- **reload 不另造设置重载器**：让 SDK 保留旧 defaultTools，计算新启用工具的差异；不提前修改其 settings manager。在 beforeSessionStart 中做一次本地模型刷新，发布新配置后才等待 MCP 启动。旧扩展关闭仍由 SDK 等待，不承诺绕过这一步。
- **不保存 IDE 选择到全局默认**：模型与 Thinking setter 显式使用 `persist: false`。隔离文件型 settings 的字节对比覆盖切换模型、Thinking、恢复与 reload；这些证据不识别用户旧配置修改的历史写入者，也不约束可信扩展自行写文件。
- **正确 SDK 版本**：独立打包后 SDK 的运行时 package 查找会命中 Bridge package.json。构建期从实际 SDK package 读取版本并固化其公开 VERSION 常量；替换特征变化则构建失败。不升级 SDK，不增加运行时内部导入。
- **可定位而非猜测无响应原因**：可选 `PI_ACP_TRACE=1` 增加 SDK 生命周期类型与 reload 阶段，不输出消息正文、工具参数或认证。未增加臆测超时、自动切模型或自建重试。默认不启用，不修改 IDE 启动配置。

## 定向验证

- `scoped-models`：范围外当前项可诊断但不能设置，空/无效 scope 不扩大选择。
- `model-recovery`：真实 SDK 恢复失败的 scope 回退，以及成功恢复模型保持不变；配置文件不变。
- `model-configuration-regression`：真实 SDK 从六档切换到 low/high/max；设置不写回；reload 正确激活新增 defaultTools；扩展模拟阻塞 MCP 启动时，ACP 已收到新模型列表。
- `models`、`model-sync`、`configuration-sync`、`commands`、`persistence`：新配置、兼容入口、扩展驱动变化、恢复和本地命令。
- `approvals`、`initialize`、`sessions`、`fork`、`steering`、`mcp`：直接受影响的权限及会话/原生 MCP 契约。
- `bundle`：实际构建并复制独立分发物，验证 SDK 版本、构建指纹、reload 阶段、真实本地 MCP 重启及清理，以及既有 codemode/OAuth/图片烟测。

最终分两组执行以上定向用例：8 文件 17 项、7 文件 41 项，共 **15 文件 58 项通过**；typecheck、`git diff --check` 通过。独立包测试已重建 dist，检查时未发现相应测试子进程残留。

没有调用真实 provider，没有做全量测试或真实 IDE UI 验收。“消息发出无下文”的那一次现场仍缺少 Bridge 请求链路证据，不能宣称根因已定位或完全修复。原生 `clion` MCP 断开也未被据此认定为原因。

更新后需真正重启 agent，再重新加载已有会话以取得新的模式广告；`/reload` 不加载新版 Bridge。无需删除个人配置、认证或历史。
