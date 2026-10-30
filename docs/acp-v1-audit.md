# ACP v1 会话发现与协议审计

## 基准与范围

本次以项目实际使用的 `@agentclientprotocol/sdk@1.8.0` 和 ACP 官方 v1 文档为基准。官方仓库核对版本：`ac765763d483dd92fb5b57aec154d45586be2717`。

- [初始化与能力协商](https://github.com/agentclientprotocol/agent-client-protocol/blob/ac765763d483dd92fb5b57aec154d45586be2717/docs/protocol/v1/initialization.mdx)
- [会话列表](https://github.com/agentclientprotocol/agent-client-protocol/blob/ac765763d483dd92fb5b57aec154d45586be2717/docs/protocol/v1/session-list.mdx)
- [会话加载、关闭](https://github.com/agentclientprotocol/agent-client-protocol/blob/ac765763d483dd92fb5b57aec154d45586be2717/docs/protocol/v1/session-setup.mdx)
- [会话删除](https://github.com/agentclientprotocol/agent-client-protocol/blob/ac765763d483dd92fb5b57aec154d45586be2717/docs/protocol/v1/session-delete.mdx)
- [错误处理](https://github.com/agentclientprotocol/agent-client-protocol/blob/ac765763d483dd92fb5b57aec154d45586be2717/docs/protocol/v1/error.mdx)
- [内容块](https://github.com/agentclientprotocol/agent-client-protocol/blob/ac765763d483dd92fb5b57aec154d45586be2717/docs/protocol/v1/content.mdx)
- [配置选项](https://github.com/agentclientprotocol/agent-client-protocol/blob/ac765763d483dd92fb5b57aec154d45586be2717/docs/protocol/v1/session-config-options.mdx)、[模式](https://github.com/agentclientprotocol/agent-client-protocol/blob/ac765763d483dd92fb5b57aec154d45586be2717/docs/protocol/v1/session-modes.mdx)
- [扩展机制](https://github.com/agentclientprotocol/agent-client-protocol/blob/ac765763d483dd92fb5b57aec154d45586be2717/docs/protocol/v1/extensibility.mdx)

`session/fork` 按当前 SDK 的实验性接口及官方 RFD 保留，不将其描述为已稳定的 v1 核心方法。未引入 ACP v2。

这是针对现有桥接代码的源码与定向契约审计，不是官方认证，也不是所有提供方、编辑器和扩展的兼容性或安全性证明。

## 发现与修复

| 问题 | 规范或设计依据 | 修复 |
| --- | --- | --- |
| 每次列表和翻页调用 Pi `listAll()`，全量读取、解析历史正文并构造全文搜索字符串 | ACP 只规定元数据、过滤、游标和合理页大小，不规定存储算法；这是严重的实现性能问题，不是“协议要求全扫” | 改为范围内文件发现、按页有界读取和短期快照；彻底移除列表对 Pi 全文列表接口的调用 |
| `cwd` 在全项目扫描后才过滤 | 官方要求结果匹配 `cwd`；当前实现结果虽可正确，但不应为查询一个项目读取其他项目正文 | 默认目录布局下直接定位对应工作目录；共享自定义目录仍需按头部 cwd 过滤 |
| 翻页重新排序，新增会话可使 offset 重复或漏项 | 不透明 cursor 的实现应支持可靠分页 | 使用连接内随机游标和稳定候选快照；同一有效游标的重试复用同一个结果 Promise |
| 删除的会话可能从另一份同 ID JSONL 再次出现 | 删除后不应出现在未来列表中；软删除、硬删除均可 | 删除选中文件，并在现有注册表保留原生 ID 和别名的删除标记，阻止复制历史在重启后重新出现；本连接旧游标失效 |
| 未初始化或初始化尚未完成也能执行会话请求 | 官方建议以 `-32600` 拒绝初始化前的请求 | 在 SDK 方法入口加连接生命周期守卫；失败的初始化可重试，成功后禁止重新协商能力 |
| 未知或已关闭会话返回 `-32602`，错误包装丢弃会话 ID | 官方建议 `-32002`，并设置 `data.sessionId` | 统一未知会话错误；错误脱敏层仅保留该标准、安全字段 |
| 并发忙状态、写入租约冲突使用 `-32600` | 官方区分无效请求与实现特有错误，并建议自定义错误使用保留范围外的码 | 使用 `-32900` 表示忙状态，保留现有 `session_active_writer` 原因；初始化顺序错误仍用 `-32600` |
| 重复关闭报未知会话，关闭时先移除活动条目导致取消工具状态无法发送 | 官方要求关闭先取消工作再释放资源，并建议幂等成功 | 未活动/已关闭返回 `{}`；关闭中的活动条目保留到取消与更新队列排空，再释放和移除 |
| 索引存在但历史文件已丢失时，加载/分叉可能误报内部错误，或尝试打开不存在的历史 | 未知资源应返回 `-32002`；无历史的 pending 会话不可分叉 | 打开前检查；加载不存在的持久化会话返回资源不存在；pending 会话仍可恢复，但不能凭空生成分叉历史 |
| 图片 `resource_link` 被强制读成本地附件，远程或客户端私有 URI 会失败 | 所有 Agent 都必须支持 `resource_link`；链接是引用，不等于内嵌图片 | 所有链接均保留为引用，不自动访问本地或远程资源 |
| 声明 `embeddedContext`，但只支持文本资源，拒绝 blob 资源 | 官方资源内容包含 text/blob 两种形态 | 图片 blob 转原生图片；其他 blob 带 URI、MIME 和明确的 base64 编码标记传入上下文 |
| `session/set_mode` 接受未出现在 availableModes 的 thinking 值；配置 setter 接受未发布的 `mode` 别名 | modeId 应属于 availableModes；未知 configId/值返回 `-32602` | mode 只操作已声明的工具策略；思考等级只通过已发布的 thinking 选项修改；显式用户策略修改允许在生成期间应用 |
| 回放遗漏 Pi 的直接 shell 执行消息 | `session/load` 必须在响应前回放完整对话，而不只是模型上下文 | 将 shell 命令和结果回放为执行工具调用；继续使用未压缩的活动分支历史 |
| Pi 文本块可携带 `textSignature` 等非 ACP 字段并被原样发送 | 标准对象根部不得添加自定义字段；提供方私有签名也不属于显示内容 | 显式投影 text/image 内容块，只发送标准显示字段 |
| 编辑器文件系统只根据错误文本识别缺失文件 | 官方文件资源缺失码为 `-32002` | 优先识别标准错误码，保留旧客户端文本兼容 |

不把“旧游标是数字字符串”或“之前结束时返回 null”单独认定为协议违规：客户端必须把游标当作不透明字符串，SDK 也允许可空字段。新实现结束时直接省略 `nextCursor`。

## 会话发现设计与成本边界

```text
session/list
  首次：目标目录文件名 + stat → 按 mtime 排序 → 读取足够一页的有界元数据
  后续：复用候选快照 → 继续取一页 → 无需重枚举、重排序全部历史

session/load / session/fork
  先查注册表 → 未命中时按原生 ID 匹配文件名 → 核验对应文件头
  非标准导入文件名：仅以有界头部探测作为备用定位，不解析正文
  只有真正加载/分叉时才让 Pi 读取选中历史的完整正文
```

- 每页 50 条，用一个额外有效条目判断是否有下一页。
- 默认头部和尾部各最多读取 64 KiB；单个文件元数据读取总量不超过 128 KiB，不为完整解析巨大 JSON 记录而继续扩窗。
- title 为可选元数据：只使用完整落在读取窗口内的名称/消息文本。巨型记录或窗口外的名称可能没有预览，不为补预览退回全文读取。
- `updatedAt` 使用文件 mtime，包含持久化元数据变化，不额外全文统计最后一条对话消息的时间。
- 缓存最多 2048 份按路径、mtime、大小、inode 区分的文件元数据。
- 保留最多 8 个分页游标，快照有效期 5 分钟。过期、被淘汰、作用域不匹配或本连接删除后的游标返回 `-32602`，客户端重新请求首页。
- 同 ID 历史去重，并优先保持已注册的 ACP ID。新建但尚未落盘的已注册 pending 会话也可发现，不再为了凑预览隐藏合法会话。
- 未索引历史优先依据 Pi 标准的 `<timestamp>_<id>.jsonl` 文件名直接定位；匹配失败时只对非标准导入/重命名文件探测头部，默认每个 4 KiB，超长头部最多 64 KiB。因此手工重命名的合法历史也能跨连接按原生 ID 恢复，而不退回全部正文扫描。若此类文件很多，备用头部探测仍有 O(K) 成本，持久化 ID→路径索引是下一层优化。

### 仍然存在的性能边界

首次请求仍有目标范围内文件名枚举、`stat` 和排序成本，分别约为 O(N)、O(N)、O(N log N)。全局列表的 N 是所有项目文件数；带 cwd 时只涉及该项目默认目录，以及该范围内的已注册外部路径。候选数组和去重集合也随 N 增长。

这是文件存储下的有界元数据分页，不是数据库索引查询，也不是 O(1) 发现。正常无重复、有效文件下，每页读取约 51 份元数据；损坏文件、重复历史、删除标记或共享目录 cwd 过滤可能增加探测数，最坏仍会遍历候选文件，但不会全文解析它们。

现有 `acp-sessions.json` 注册表仍按整体 JSON 读取/更新，删除标记也会占用少量空间。元数据缓存和分页快照仅在连接内复用，不跨进程持久化；不同进程的既有快照不提供实时一致性。对于十万级以上历史或高频全局查询，下一层优化应是持久化元数据索引及增量维护，而不是提高并发或增加全文扫描缓存。

## 核对后保持不变的行为

- 不支持请求的协议版本时返回本端最新支持版本，由客户端决定是否继续，符合版本协商规则。
- stdio MCP 为基础能力，HTTP 显式声明；SSE 不声明、不接受。
- 不声明 audio、additionalDirectories、resume 等未实现的可选能力。未声明的压缩实体/notice 客户端能力也不被擅自使用。
- 配置响应继续返回完整 configOptions，并保持工具策略配置和 legacy modes 同步。
- `session/load` 回放完整活动分支，而非压缩后的模型消息；不会回放未显示的扩展状态或系统私有提示。
- 权限请求继续只接受已知的 allow 选项，取消不视为授权；文件系统调用仅在已协商的客户端能力下启用。
- `session/delete` 仍不是工作区回滚，也不会删除图片素材。复制的 JSONL 可保留在磁盘上，但删除标记阻止它重新出现在 ACP 列表和恢复路径中。

## 验证

使用本地现有依赖，无新增依赖、全局安装、真实模型请求或浏览器：

```bash
pnpm run typecheck
pnpm run test:acp
pnpm run build
```

定向契约包括分页探测次数、游标并发重试、快照稳定性、cwd 范围、精确 ID 定位与重命名导入、2 MiB 历史的读取字节上限、pending 会话、删除复制历史后重启、初始化顺序、未知会话错误、幂等关闭/删除、关闭期间取消和工具收尾、内容块及历史回放。

已通过类型检查、12 个定向测试和本地 standalone 构建，`dist/` 已更新。没有执行真实 MCP/提供方互通、多编辑器端到端回归或发布安装流程。测试构建与临时夹具仅位于 `.scratch/`，测试夹具在结束后清理；不启动监听端口或常驻进程。客户端需要重启代理进程才能加载新的打包代码，`/reload` 不会替换桥接程序。
