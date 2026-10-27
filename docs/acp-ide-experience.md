# 第二批：IDE 体验实现依据与边界

本轮覆盖编辑器文件工具、上下文来源、MCP 状态/定向重连及扩展配置同步。延续 [第一批](acp-reliability.md) 的原则：优先复用 Pi SDK 公开能力，不照搬其他后端私有 API，不把 Bridge 扩成另一套 agent runtime。

## 1. 文件系统：没有“成熟实现都采用 A”的依据

实际核对的 [Gemini ACP 文件系统服务][gemini-fs] 对 read/write **分别**检查 capability，缺少某项就回退本地；工作区外、全局 CLI 配置目录也走本地。它不采用“只支持 read 就禁止 edit/write”的 A 策略。不能把 A 描述成上游共识。

本 Bridge 采用**成对启用**：客户端同时声明 ACP `fs.readTextFile` / `fs.writeTextFile` 时，工作区文本 read/edit/write 才统一委托；否则保持 Pi 原有磁盘行为。不支持的客户端不发送 fs RPC，也不凭空新增只读拒写策略。

这是对 Pi 工具结构的明确适配差异，不是原样照搬 Gemini：

- 路由、profile 排除、缺失文件错误归一化参考 Gemini。
- 通过 Pi SDK **公开根 exports** 的 `createReadToolDefinition`、`createEditToolDefinition`、`createWriteToolDefinition` 和 operations 接口接入。不深层导入未公开文件，不重写匹配、BOM/换行、图片处理、截断或 mutation queue。
- 使用隐藏、可替换的 `ide-filesystem` inline 扩展。用户扩展注册同名工具时，沿用 SDK replaceable 机制让出整组适配，不强压用户工具；不是第四个 MCP built-in。
- 每个新建/恢复会话绑定自己的 ACP ID；reload 继续使用该会话的适配。没有修改进程 cwd 或个人配置。
- 对编辑器请求的实际失败不降级到磁盘；read 的原生图片检测和读取、工作区外及 Pi profile 文件保留本地行为。read 的图片 resize 设置仍取 Pi 当前配置。
- delegated edit 的 oldText 来自 SDK 实际读取的缓冲区；write 的 oldText 来自写前编辑器快照；newText 来自写成功后的编辑器读回。客户端格式化不被误报成“模型提交的文本”；未知快照不编造 Diff，明确 missing 才标 creation。

### 限制

- 路径范围判断是路由，不提供 symlink 安全边界；工作区不是 sandbox。
- bash/grep/find/ls 仍访问磁盘。写入缓冲区不等于落盘，编辑器保存策略由客户端决定。
- ACP v1 没有 buffer revision/CAS，不能承诺与用户同时编辑原子一致；没有自造冲突检测协议。
- 当前 ACP SDK 的 fs 方法没有 AbortSignal 参数。不能假称可以强行撤销已发出的写请求；延续 Pi mutation queue 的结算语义，不用 timeout 伪造回滚。
- write 前后快照只是呈现用途：快照失败不等价于写权限拒绝；实际写失败由客户端返回，不为缺失快照发明旧内容。

## 2. 上下文来源

参考 Claude ACP 的 [`promptToClaude()`][claude-agent]：嵌入文本附带 `<context ref="URI">`。Bridge 保留 URI（含片段）与 MIME，普通 resource link 保留 name/title/description 等已提供字段，属性进行转义；正文按收到的内容传递。不解析未知私有元数据猜行号，不自动抓取任意远端 URI，也不把封装描述成 prompt-injection 安全边界。直接文本命令仍由原解析器处理，附件不能变成 Bridge 命令。

## 3. MCP 状态与定向重连

第一批已经接入 Pi 原生 MCP，SDK 1.2.0 本身提供：

```text
/mcp
/mcp reconnect <原始服务器名>
```

实际核对原生 `extensions/mcp/index.js` 的 `formatStatus`、服务器选择与 reconnect 分支：非 TUI 模式通过 notify 输出状态、失败原因和覆盖关系；带名字的 reconnect 只操作目标连接。因此本轮**不新增连接管理器或仿造状态接口**，而是定向验证既有命令在 Bridge 中可用：

- 本地 stdio 假服务器经真实 SDK 启动，调用 echo 取得各自 PID。
- 重连 native `shared-name` 后，旧 PID 消失、新 PID 可调用；独立 IDE 服务器保持存活。
- native 配置仍优先，`/mcp` 保留 overridden 信息；禁用 builtin 后清理两台服务器。

原生 status 可以把连接错误放在 `info` 通知中，所以 Bridge 的通知脱敏不再只依赖 severity=error；info/warning/error 都经过同一凭证摘要边界。此边界有长度预算，不是任意文本的完整 DLP，也不能替代远端 OAuth/实际 IDE 验收。

## 4. 配置同步

参考 Claude ACP 的 `updateConfigOption()` / `config_option_update`：配置变化必须进入标准配置更新，不只影响内部状态。Bridge 继续复用 `sessionConfiguration()` 的完整快照，在 new/load 保存基线，在已有 setter/reload 发布时更新基线；每轮结算比较快照，仅有变化时发布 model/Thinking 及相关选项。

这是按 Pi 生命周期做的批处理，不是声称上游使用了同样的 diff 算法。扩展在本轮改变配置后不会等到用户手工 reload；无变化的命令不重复发布，不在每个 token delta 上计算。失败/取消结算仍可发送配置元数据；取消后不新增配置警告文本。后台扩展在无活动轮次时的任意变化不保证即时推送，会在后续轮次结算校正。

## 5. 验证记录

测试边界经用户同意：纯映射、隔离 ACP 请求、真实 Pi SDK 配本地假编辑器/MCP；不调用真实模型。主要新增项逐项 red/green：上下文丢来源、扩展改模型后没有配置更新、编辑器缓冲区未读取，以及 info 类型错误通知漏脱敏。

最终定向检查分两组，每组低于 30 秒：

- `client-filesystem`、`configuration-sync`、`content`、`tools`、`commands`、`multimodal`、`custom-messages`、`image-links`：8 文件，27 项。
- `mcp`、`sessions`、`pending-session`、`persistence`、`workspace-isolation`、`bundle`：6 文件，26 项。
- 共 **53 项定向通过**；`pnpm run typecheck` 与 `git diff --check` 通过。bundle 测试实际构建并运行独立产物。

修正两个既有测试夹具：图片工具补齐 start→end 生命周期；并发工作区测试按助手输出观察隔离，不再假定固定通知条数。保留原来的图片/路径、工作区上下文与历史隔离断言，没有删测试或跳过分支。

没有跑全套测试、真实 provider、远端 MCP/OAuth 或 Air/JetBrains UI。协议/SDK 的 buffer/Diff 通过不等于目标 Air 已声明 capability、已展示同样 UI 或已按预期保存文件。重启 agent 后先用 `/doctor` 确认是否加载编辑器委托，再做少量真实未保存文件主干验收。

第三批权限/Plan、fork、steering、后台终端没有在本轮悄悄加入；后续仍须先核对成熟实现、Pi 公开接口及客户端协商能力。

## 固定参照

- [ACP v1 文件系统协议][protocol-fs]：capability 必须先检查，write 必须支持创建不存在的文件；并未要求部分能力客户端一律拒绝本地工具。
- [Gemini 文件系统服务][gemini-fs]：固定提交 `363a13119a57354f469732577518b9d6b319d1d6`，分别能力探测、路由与错误归一化。
- [Claude ACP][claude-agent]：固定提交 `0ce42f2c312d190f78024d8b4b1ae5f00d9e5939`，`promptToClaude` 来源封装及标准配置通知。
- 本地锁定 **Pi SDK 1.2.0**：公开 root exports、tools operations declarations/implementation、replaceable 扩展机制、非 TUI `/mcp` 状态和定向重连。内部源码只用于确认行为；运行时使用公开 API。

[protocol-fs]: https://github.com/agentclientprotocol/agent-client-protocol/blob/c3790ac34421633c3c1cdbbdff964b647270cec9/docs/protocol/v1/file-system.mdx
[gemini-fs]: https://github.com/google-gemini/gemini-cli/blob/363a13119a57354f469732577518b9d6b319d1d6/packages/cli/src/acp/acpFileSystemService.ts
[claude-agent]: https://github.com/agentclientprotocol/claude-agent-acp/blob/0ce42f2c312d190f78024d8b4b1ae5f00d9e5939/src/acp-agent.ts
