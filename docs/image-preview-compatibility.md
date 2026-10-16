# IDE 图片输出兼容性核查

核查时间：2026-10-16。区分“图片输入给模型”“助手正文预览”“工具结果预览”“点击文件链接”。源码证据不能替代实际窗口验收。

## 当前证据

| 客户端 | 助手原生 ACP 图片 | 工具图片 | Markdown 本地图片 | 证据级别 |
| --- | --- | --- | --- | --- |
| Air 262.1037.6 | 诊断 Agent 实测显示 JSON/Base64 | 用户补充确认 Results Retrieved 中可打开文件，但聊天内无预览 | 诊断实测 `markdown-file` 显示为 `!` + 链接，未预览；普通 file URI 链接可打开 | 用户实测 + 本机字节码 |
| CLion 2026.2.3.1，AI Assistant 262.10968.223 | 诊断实测图片块无显示，仅见前后测试文本；符合非文本返回空列表的源码 | 显示“读取 fixture.png”，可点击在编辑器图片标签页查看，聊天内无图片预览 | `markdown-file` 原样显示 Markdown 图片语法，不预览 | 用户窗口截图 + 本机插件字节码 |
| PyCharm AI Assistant | 未安装，不能宣称已验证；应记录实际插件版本后重复测试 | 待验证 | 待验证 | 未实测 |
| Zed | 当前主干存在共享输出内容块的图片渲染分支，实际安装版本仍需核查 | 源码明确存在图片渲染函数；MCP 图片输出支持 PR 已合并 | 未单独验证 | 公开源码，未安装/未窗口实测 |

### Air

本机 `fleet.plugins.ai.frontend.jar` 的 `fleet.ai.frontend.agents.acp.AcpAgentFrontendKt.handleAgentMessageChunk`：文本取 `ContentBlock.Text.getText()`，其他块 `Json.encodeToString` 后作为字符串展示。该结论只针对当前 ACP 助手消息路径，不推广到整个产品或所有图片入口。

### JetBrains AI Assistant

本机路径：`~/Library/Application Support/JetBrains/CLion2026.2/plugins/ml-llm/lib/modules/intellij.ml.llm.agents.acp.jar`。

`com.intellij.ml.llm.agents.acp.session.Acp2ToAUIConverter.processAgentMessageChunk(SessionUpdate.AgentMessageChunk)` 仅接受 `ContentBlock.Text`，否则 `CollectionsKt.emptyList()`。类名包含 `2`，但所检查的方法参数确实是当前桥接器使用的 v1 `SessionUpdate.AgentMessageChunk`；不以此推断所有 v2/其他客户端行为。

官方 [AI Chat 文档](https://www.jetbrains.com/help/ai-assistant/chat-mode.html) 的图片上传功能不构成输出预览证据。[MCP 文档](https://www.jetbrains.com/help/ai-assistant/mcp.html) 关于 PNG 的搜索结果涉及 Notebook 输出保存为临时 PNG，也不能当成 ACP 聊天内图片预览承诺。

### Zed

核查时主干 SHA：`6b218b8412d2e5aae339ce3826756be561f7efe9`。

- [MCP 图片输出 PR #57134](https://github.com/zed-industries/zed/pull/57134)，2026-05-19 合并：将图像加入模型上下文，同时通过 `ToolCallContent::Content(ContentBlock::Image)` 提供给 UI，不只是模型输入支持。
- [thread_view.rs](https://github.com/zed-industries/zed/blob/6b218b8412d2e5aae339ce3826756be561f7efe9/crates/agent_ui/src/conversation_view/thread_view.rs)：`render_output_content_block` 的 `content.image()` 分支调用 `render_image_output`；后者创建 `img(image).max_w_96().max_h_96().object_fit(ObjectFit::ScaleDown)`，明确是 UI 图片展示。
- 主干存在 ACP v2 结构；不能未经版本核对，直接推断任意已发布版本都具备完全相同的行为。

## 对桥接器设计的影响

不要把 Air 的兼容降级等同于所有 IDE 的协议能力。初轮调查只收集证据，未修改生产策略。随后用户选择先用工具结果：桥接器保留原生工具图片，在同一最终结果附加文件链接、可复制路径和 ACP `locations`，不再为同一工具图片额外发送助手正文。本地 Markdown 图片仍降级为文件链接；不按客户端名字猜测能力。新版策略的协议测试已通过，但仍需各客户端界面验收。若客户端支持正文原生图片，后续可考虑可选择的展示策略。

## 无模型 UI 诊断 Agent

脚本：`experiments/image-preview/probe.mjs`。

运行要求：项目已安装依赖，Node 22.22.0。脚本生成固定 128×128 四色 PNG 到 `.scratch/image-preview/fixture.png`；不读取个人 Pi 配置、不调用模型、不连接客户端 MCP、不执行工具或网络请求，不启动 Pi 实例。

注册为一个独立的临时 ACP Agent，不替换现有 Pi Agent：

```json
{
  "command": "/Users/raiden/.local/share/mise/installs/node/22.22.0/bin/node",
  "args": ["/Users/raiden/workspace/projects/active/pi_acp_bridge/experiments/image-preview/probe.mjs"],
  "env": {}
}
```

经用户同意，已注册 `Image Preview Probe`：

- Air：`~/Library/Application Support/JetBrains/Air/acp.json`，保留已有代理；原文件备份 `.scratch/image-preview-research/air-acp.before-probe.json`。已观察到 Air 自动完成 initialize/session/new 探测。
- CLion：插件确认读取 `~/.jetbrains/acp.json`，此前文件不存在，现新建并仅加入诊断代理，禁用该代理的 IDE/custom MCP。重启后已于 22:40:37 观察到 CLion 加载，实测结果见上表。
- 撤销时仅移除 `Image Preview Probe` 条目；不要覆盖后续用户改动。
- `.scratch/image-preview/trace.ndjson` 只记录进程、客户端名称/版本、已知测试类型及完成事件，不记录任意输入文本或图片内容。

每次输入以下一种测试名：

| 输入 | 输出 |
| --- | --- |
| `image` | 原生 ACP `agent_message_chunk` 图片 |
| `tool` | 原生 ACP 工具结果图片；同时检查是否需要展开工具 |
| `markdown-file` | `![测试图片](file:///...)` |
| `markdown-data` | `![测试图片](data:image/png;base64,...)` |
| `link` | 普通 Markdown file URI 链接 |
| `resource` | ACP `resource_link` |

记录结果为：正文内嵌预览 / 展开工具后预览 / 仅可点击链接 / JSON 原文 / 无内容 / 错误，并记录版本。

已通过 stdio 协议冒烟：六种测试均返回预期内容块及 `end_turn`；这不代表六种模式在 IDE 界面均可显示。已获得用户同意并注册。22:38 的 Air 跟踪确认 `tool`、`markdown-file`、`image` 均请求并完成；22:38:49 用户截图结果已记入上表。CLion 最初未加载新配置；22:40:37 已记录 `client: JetBrains.CLion, version: 2026.2.3.1` 初始化，随后三种测试均完成。22:41:29 截图确认工具文件可在编辑器图片标签页查看，但聊天正文不预览；Markdown 图片原样显示，原生助手图片不显示。22:42:15 的 `markdown-data` 请求已完成，但尚无对应窗口结果，不能仅凭完成事件判断显示成功。无需重新生成图片或调用收费模型。
