# 会话命令与长上下文验证记录

日期：2026-10-16。关联 #7 的后续完善；不据此关闭真实 IDE 验收项。

## 本轮交付

- `/session`：显示 ACP/Pi 会话、历史文件、模型、累计用量和可用的上下文占用估计，不调用模型。
- `/reload`：重载 Pi 资源、刷新命令/模型配置通知，保留对话；MCP 使用当前客户端配置重连。
- `/compact [摘要要求]`：走 Pi 原生压缩流程，支持取消和空历史提示，不更改用户全局压缩设置。实际使用通常产生模型费用。
- 自动压缩、超限重试、重试等待增加文字状态，避免界面无反馈。
- 扩展文字通知接入 ACP，去掉 ANSI 颜色控制码；初始化无 watcher 的主题。终端弹窗明确提示改用 Pi CLI，不假装已确认。
- 工具图片保留原生内容，并在工具结果内提供文件链接和导航；不再额外插入同一图片的助手消息。

## 复现并修复的问题

1. **压缩后恢复丢失早期消息展示**：原先回放 `session.messages`，它是模型使用的压缩后上下文。现在从 `sessionManager.getBranch()` 回放完整当前分支，模型仍使用压缩后的上下文，不把旧历史重新塞回模型。
2. **重载中关闭导致资源泄漏**：原先 close 可以先 dispose 旧 runner，随后 reload 又创建新资源。现在取消展示后等待活动操作收尾，再 shutdown/dispose 替换后的资源。
3. **扩展命令执行却没有反馈**：`ctx.ui.notify()` 原先没有协议出口；现在转为文字。终端彩色通知原本会带 ANSI 转义码，一并清理。
4. **内置命令可能被误发给模型**：在调用 Pi `prompt()` 前拦截三条命令；额外参数、附件明确校验，嵌入文档不触发桥接内置命令。

## 自动化证据

环境：已有项目 `node_modules`，mise Node 22.22.0、pnpm 12.9.1。没有安装新依赖。测试资源仅落在项目 `.scratch/`，没有收费模型请求，没有修改个人认证。

```bash
mise exec node@22.22.0 -- pnpm run typecheck
mise exec node@22.22.0 -- pnpm exec vitest run \
  test/commands.test.ts test/context.test.ts test/sessions.test.ts \
  test/mcp.test.ts test/multimodal.test.ts test/persistence.test.ts \
  test/models.test.ts test/tools.test.ts test/workspace-isolation.test.ts \
  test/bundle.test.ts
```

定向结果：**10 个测试文件、27 个测试通过**；测试运行约 1.4 秒。类型检查通过。不是全套测试声明。

- 真实 Pi SDK + 内存假模型流：长历史手动压缩、摘要要求传递、压缩后继续对话、完整聊天恢复；取消压缩、busy 保护、空会话；模型上下文超限后压缩并在同一个 ACP 请求中继续。
- 真实本地 MCP：stdio 和 HTTP 工具调用；重载关闭旧连接/子进程后重新调用成功；字面凭据不变；恢复时采用新配置；关闭清理。
- 既有日常链路：模型切换后的实际模型选择、工作区与相对读取隔离、文本/思考流、工具 Diff、图片输入/输出、取消/断线和 JSONL 恢复。
- 独立 bundle：构建产物小于 10 MB；禁止外部模块加载和 fetch，验证扩展、OAuth 派生、图片 WASM、`/session`、`/reload`、MCP 重连及 SIGTERM 清理。构建不会自动替换正在运行的 IDE 代理进程。

源码检查按约定与需求两方面进行；本轮没有可用的独立子代理审查工具，不将自查冒充独立审查。

## 仍需人工验收 / 未开展

- 重新启动代理进程后，Air/CLion 的命令菜单刷新、压缩状态和取消按钮、新版工具文件导航。
- 真实模型摘要质量、真实远端 token 上限和网络抖动表现；假模型只验证控制流程，不证明内容质量。
- Air 原生 Diff、真实模型下拉切换；不能用协议测试代替这些 #7 验收项。
- PyCharm 和 Zed 的版本化界面验证；本轮没有安装软件。
- macOS 浮动截图拖入后、ACP 请求尚未到达时的卡住问题。
- IDE ↔ Pi 终端偶尔手动交接历史仍按用户要求延期；`/reload` 不承担此功能。
- 临时 Image Preview Probe 注册与脱敏跟踪入口保持原样，没有删除聊天、缓存、IDE 状态，也没有重启用户 IDE。之后清理时只移除自己的条目，不能覆盖用户后续改动。

用法和协议边界见 [protocol.md](protocol.md)；IDE 重连提示见 [air-integration.md](air-integration.md)；图片 UI 证据见 [image-preview-compatibility.md](image-preview-compatibility.md)。
