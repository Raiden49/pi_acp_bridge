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

模型下拉框通过 ACP `configOptions` 广告，并用 `session/set_config_option` 切换；它不是初始化 `_meta` 扩展。列表包含尚无凭据的模型，因此请用已有认证的模型验收。正在生成时切换返回 busy，应等提示结束或取消后再切换。模型变化只属于当前会话，不修改 Pi 全局默认值。

若 Diff 未出现，确认工具为 `edit` 或 `write` 且真的改变了文件；bash 任意文件变更不在当前 Diff 捕获范围内。若无法连接，检查绝对路径、构建产物和 Air 日志；不要向桥接器 stdout 添加诊断输出，因为该流只用于 ACP。

## 自动化证据

- `pnpm run build`：生成压缩 bundle，保留可执行 shebang。
- `pnpm exec vitest run test/bundle.test.ts`：真实子进程握手，禁止外部模块加载，无模型网络请求。
- `pnpm exec vitest run test/models.test.ts`：真实 Pi 会话经 ACP 切换，确定性模型流证明下一次提示使用新模型，其他会话不变。
- `test/persistence.test.ts`：恢复会话继续提供模型配置；`test/sessions.test.ts`：活动提示期间拒绝切换。

以上不证明真实 Air 界面已通过。人工结果确认之前，#7 的三个真实 IDE 验收项保持未完成。
