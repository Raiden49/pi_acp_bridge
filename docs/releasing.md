# 构建与分发

本项目分发形式是独立 Node.js CLI：`dist/index.js`。当前 `package.json` 标记为 `private`，不执行 npm 发布。源码提交、GitHub Release 和 npm 发布是不同操作；本文不表示已创建版本标签或上传发行附件。

## 环境与构建

使用项目锁定的 pnpm 12.9.1 和 Node.js 22.19+；本机验证使用 mise Node 22.22.0。项目依赖必须位于本地 `node_modules`，不安装全局包。

全新检出先安装项目依赖：

```sh
mise exec node@22.22.0 -- pnpm install --frozen-lockfile --ignore-scripts
```

已有依赖时无需重新安装。类型检查及本次变更相关的定向验证：

```sh
mise exec node@22.22.0 -- pnpm run typecheck
mise exec node@22.22.0 -- pnpm exec vitest run \
  test/commands.test.ts test/context.test.ts test/sessions.test.ts \
  test/mcp.test.ts test/multimodal.test.ts test/persistence.test.ts \
  test/models.test.ts test/tools.test.ts test/workspace-isolation.test.ts \
  test/bundle.test.ts test/questions.test.ts
```

这些测试使用本地假模型和隔离资源，不调用收费模型；这是一组定向检查，不是全量回归。bundle 测试会重新构建产物，验证无相邻依赖运行、协议交互、扩展加载、图片 WASM 和 MCP 子进程清理。

单独构建及计算分发校验值：

```sh
mise exec node@22.22.0 -- pnpm run build
shasum -a 256 dist/index.js
```

`dist/index.js` 含 shebang，使用压缩的单文件 ESM；大小预算小于 10 MB。复制到目标机器后，用 Node 启动，无需复制仓库 `node_modules`：

```sh
node /absolute/path/to/index.js
```

标准输出专用于 ACP NDJSON；该程序由 ACP 客户端管理输入输出，不是交互式终端聊天程序。用户自行配置的扩展包仍需在目标环境可用，独立 bundle 不会打包个人扩展、认证或会话历史。

## 集成与升级

- Air in IDEs 使用 `~/.jetbrains/acp.json`；独立 Air 使用它自己的配置文件。注册示例和客户端区别见 [air-integration.md](air-integration.md)。
- 替换产物后必须重启代理进程；`/reload` 只重载 Pi 资源，不升级运行中的桥接代码。
- 无需清空 IDE 聊天、删除 JSONL 或迁移认证。
- 模型与 Thinking 使用标准配置项；Pi `select/input/editor/confirm` 使用标准 ACP 表单；`/name` 兼容 Pi 已有语法。不附带新的问答工具，不针对某个插件做特殊适配。
- 客户端必须声明 `elicitation.form` 才能交互。SDK 输入原语没有结构化多选参数时，桥接器不会从文案推断复选框。
- 用户标题、模型历史、工具执行及权限边界见 [protocol.md](protocol.md)。文件和命令继续由 Pi 执行，不构成文件系统沙箱。

## 验收边界

协议和独立 bundle 通过不代表所有 IDE 控件均已人工验收。正式发布前应在目标版本验证 Thinking 选择、表单提交/取消、`/name` 标题展示、聊天恢复与 Diff。当前版本化证据见 [session-commands-validation.md](session-commands-validation.md)。

不随发行物打包 `.scratch/`、个人配置、认证、会话 JSONL、IDE 工程状态或诊断跟踪脚本。该桥接器不实现会话删除、历史列表、终端交接或额外工作目录。
