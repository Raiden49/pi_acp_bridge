# F1 / F2 修复记录

基线：`8d7f3e8a`。本轮只处理审查中的 F1、F2；未修改 F3 的模型恢复策略，也未进行 S1 所提的大规模拆分。

## F1：异常退出后恢复索引写入

- 保留 `acp-sessions.json` 的格式、权限及临时文件 + 原子 rename 写入方式，不迁移会话数据。
- 用 Node 内置 SQLite 的 `BEGIN IMMEDIATE` 事务持有操作系统锁。协调文件为 `<索引路径>.lock.sqlite`，不保存会话映射，不需要数据库服务或新依赖。
- 活跃锁等待最多 5 秒后失败，绝不按锁龄或等待时长强行抢占。进程被强杀后由操作系统释放锁，无需猜测 PID、处理 PID 重用或竞争删除锁目录。
- 新写入者取得锁后，只清理本索引命名空间中 UUID 格式的遗留临时文件。读取损坏索引仍会失败，不以空索引覆盖。
- 协调文件需要常驻，运行时不能删除或替换。旧 `.lock` 目录不再使用，也不自动删除。

**升级限制：**必须停止所有旧版桥接进程后再运行新版，不支持使用旧目录锁和新事务锁的进程同时写同一索引。旧锁没有所有者信息，无法安全自动判断旧进程是否还在运行；本轮不假装能够识别这种情况。本实现面向本机文件系统。

**测试证据：**旧遗留目录不阻止新版；真实子进程持锁时，即使测试将等待期限推进到超时也不抢锁；SIGKILL 结束该测试进程后恢复写入并清理中断临时文件；两个并发实例保留全部映射；损坏索引保持原内容。所有测试文件位于 `.scratch/`，不操作真实索引。

## F2：等待模型切换后再销毁会话

- 将 `changingModel` 从布尔值改为始终结算的 Promise；认证失败也能解除 busy 和关闭等待。
- close 先从活动会话表移除会话，拒绝新请求；等待当前模型切换结算，再执行扩展 shutdown / dispose。
- 断线及服务器 shutdown 采用相同清理路径；额外跟踪已经由 close 移出会话表、但尚未清理完毕的操作，防止此时 shutdown 提前完成。
- SDK 没有可靠的 `setModel` 中止接口，因此不会在超时后仍有代码运行时强行 dispose。如果上游认证永不结算，关闭仍需等待；不能以重新引入写入竞态来保证即时退出。

**测试证据：**通过内存 ACP 请求与可暂停的 SDK 会话边界覆盖 close、断线、shutdown、close 后再 shutdown、切换失败和失败后重试。验证切换发生在 dispose 之前、关闭开始后拒绝新提示；已有取消及 reload-close 测试继续通过。

## 构建与验证

生产 bundle 曾复现 `node:sqlite` 被构建工具改写为外部 `sqlite` 包的问题，现设置 `removeNodeProtocol: false` 保留前缀。独立 bundle 回归通过，不依赖额外 sqlite 包。

```sh
mise exec node@22.22.0 -- pnpm run typecheck
mise exec node@22.22.0 -- pnpm exec vitest run \
  test/session-index.test.ts test/sessions.test.ts test/models.test.ts \
  test/persistence.test.ts test/commands.test.ts test/bundle.test.ts
```

结果：**6 个定向文件、23 个测试通过**，约 1 秒；类型检查通过，独立 bundle 已重新构建。未安装依赖、调用收费模型或修改个人 IDE 配置、认证及真实会话文件。

Node 22.22.0 对 `node:sqlite` 输出实验性 API 警告，位于 stderr；不会混入 ACP stdout。未修改全局告警设置。以上不是全量回归或真实 IDE 验收结论。
