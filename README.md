<p align="center">
  <img src="assets/icon.svg" alt="Pi ACP Bridge icon" width="112" height="112">
</p>

# Pi ACP Bridge

Use [Pi](https://github.com/badlogic/pi-mono) in ACP-compatible IDEs. Built on the Pi TypeScript SDK, with no separate Pi process or background service required.

Supports streaming responses and reasoning, model and Thinking selection, Pi history discovery and resume, tools and file diffs, slash commands, images, native forms, and Pi-native plus client-provided MCP servers. UI support varies by client.

## Quick start

Requires **Node.js 22.19+** and **pnpm 12.9.1**.

```sh
git clone https://github.com/Raiden49/pi_acp_bridge.git
cd pi_acp_bridge
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
```

Configure models and credentials in Pi first. The bridge reads `~/.pi/agent/` by default; set `PI_CODING_AGENT_DIR` to use another profile. ACP login is not implemented.

## Connect your IDE

### CLion / PyCharm — Air in IDEs

On macOS, install through a local registry to include the agent icon. Requires the **Air in IDEs** plugin with support for `air.acp.registry.path`; verified with CLion 2026.2 / Air 262.8665.497.

1. After building, generate the local package using the Node runtime you want the agent to use:

   ```sh
   node scripts/create-local-registry.mjs
   ```

2. **Quit the IDE and back up** its `options/ide.general.xml`. The default macOS path is:

   ```text
   ~/Library/Application Support/JetBrains/<product-and-version>/options/ide.general.xml
   ```

   Replace `<product-and-version>` with your actual directory, such as `CLion2026.2` or `PyCharm2026.2`.

3. Add or update this entry inside `<component name="Registry">`, using the absolute `registry.json` path printed by the script:

   ```xml
   <entry key="air.acp.registry.path"
          value="/absolute/path/to/pi_acp_bridge/.scratch/local-registry/registry.json"
          source="USER" />
   ```

   If the component is absent, create it inside `<application>`. Preserve all other settings; the value is a file path, not a `file://` URL.

4. Restart the IDE, install **Pi Bridge** from Air's agent catalog, and start a new chat. No entry in `~/.jetbrains/acp.json` is needed.

The script fetches the public catalog and adds **Pi Bridge**, preserving other agents and their icons. It stops on download failure rather than generating a single-agent catalog. Keep the generated directory. **The IDE uses this merged snapshot instead of the live public source**; rerun the script to refresh it. See the [setup guide](docs/ide-setup.md) for offline snapshots, changing paths, and uninstalling.

### Standalone Air Desktop — macOS

In `~/Library/Application Support/JetBrains/Air/acp.json`, add **Pi Bridge** under `agent_servers`, preserving existing agents:

```json
{
  "agent_servers": {
    "Pi Bridge": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/pi_acp_bridge/dist/index.js"],
      "env": {}
    }
  }
}
```

Replace both paths with absolute paths on your machine. Use `node -p 'process.execPath'` to locate Node. GUI clients may not inherit your shell's PATH or API-key environment variables.

Refresh the agent list or restart the client, then select **Pi Bridge** and start a new chat. Send `/session` to check the connection without calling a model.

Air Desktop does not use the IDE registry setup above. For Zed configuration, see the [setup guide](docs/ide-setup.md).

## Update

Finish active tasks and ensure the working tree is clean, then run:

```sh
./update.sh
```

This pulls upstream changes, installs locked dependencies, and rebuilds. It does not modify IDE settings, credentials, or chat history.

Keep `dist/index.js`, `dist/codemode-worker.js`, and `dist/quickjs.wasm` together; the entry file alone is not the complete distribution.

**Restart the client's agent process afterward.** `/reload` reloads Pi resources and local model configuration, not bridge code. Use `/doctor` to check the running artifact's SHA-256, SDK/Node version, profile, and model-refresh status without calling a model.

### Model settings and refresh

- New chats follow Pi CLI startup selection: use the saved default if it is in `enabledModels`, otherwise the first matching scoped model (including its explicit Thinking suffix). With no matching scope, use Pi SDK's normal default/fallback selection.
- Resumed chats preserve a successfully restored model and Thinking level. If the SDK reports restoration failure, the bridge reapplies the scoped startup selection instead of retaining an unrelated fallback. Startup diagnostics distinguish that historical fallback from the bridge's actual selection.
- After editing Pi model configuration or saving `/scoped-models` in the terminal, send `/reload` in each open ACP chat. It rereads settings, local model catalogs and availability, then publishes the selector again, preserving the current model ID, Thinking level and history. It does not fetch remote catalogs; use `pi update --models` first when needed.
- An unavailable or out-of-scope current model remains visibly marked for diagnosis without becoming an allowed selection. Other valid choices stay available. A successfully restored historical selection is not automatically replaced.
- Merely switching models in a terminal chat does not save a new startup default. Use Pi's **Ctrl+S** in `/model` to save it. Both processes must use the same `PI_CODING_AGENT_DIR`; GUI clients may also have different API-key environment variables.

## Editor buffers and configuration updates

When the client advertises **both** ACP text-file read and write capabilities, the bridge delegates workspace text `read`, `edit`, and `write` operations to the editor. Diffs use the observed editor contents, including client formatting. With either capability missing, these tools keep Pi's original disk behavior; editor request failures never silently fall back to stale disk contents.

Images, paths outside the workspace, Pi profile files, and tools such as `bash`/`grep` still use the local filesystem. This is neither a filesystem sandbox nor a read-only/permission mode. Editor writes need not be saved to disk, and ACP v1 cannot guarantee atomicity against concurrent user edits. `/doctor` reports whether the adapter is loaded.

Embedded text context retains its URI, fragment, MIME type, and supplied link metadata without fetching remote links. Extension-driven model/Thinking changes are published to the IDE at turn settlement only when the configuration changed. See [second-batch implementation references](docs/acp-ide-experience.md) for upstream comparisons and validation limits.

## 会话控制与工具审批

- 支持当前分支末尾 `session/fork`，生成独立 Pi ID 与历史，不替换源聊天、不回滚工作区；暂不支持指定消息位置。客户端须支持 ACP SDK 的实验性分叉接口。
- 支持已广告的 Claude ACP v1 `_session/steering` 契约，在运行中追加输入；Pi 按工具/模型边界消费，不中断正在执行的工具。空闲时支持 `promptRequired` 由客户端转为普通提示。
- 新会话默认直接执行。支持配置控件的客户端可通过 **Tool policy** 选择 `ask`（变更前逐次审批）或 `plan`（允许检查/计算入口，阻止写入、shell、MCP 和未知工具）。策略仅属当前会话，恢复与分叉保留；传统 modes 同步工具策略；Thinking 只通过可动态更新的 `thought_level` 配置广告，旧 Thinking mode ID 仍保留兼容入口。
- Plan 是 Pi 工具执行管线策略，不是 OS 或恶意插件沙箱；可信扩展仍能自行运行宿主代码。拒绝、取消与审批失败不会放行，取消不回滚已发生的修改。

这些控件是否展示取决于客户端，尚未进行本机 Air/JetBrains UI 验收；未实现终端/独立后台任务。上游固定提交、适配差异与测试见 [第三批实现依据](docs/acp-session-controls.md)。

## Native MCP and diagnostics

The bridge loads Pi's native `mcp`, `codemode`, and `tool-search` built-ins with the CLI's named replacement/disable semantics. Pi's user and trusted-project MCP configuration takes priority over IDE-injected servers in the same namespace. ACP-provided env/header values remain literal; SDK configuration, connections, OAuth, reconnection, and shutdown stay with Pi. Use `/mcp` for status and configuration provenance, and `/mcp reconnect <server-name>` to reconnect one server without restarting the others.

`/doctor` reports runtime/build/profile/model diagnostics, startup fallback notices, and local refresh results. It does not call a model, print credential values, or refresh remote catalogs. Paths and model/provider names can still be private; review the report before sharing it. See [protocol and maintenance contracts](docs/protocol.md), [implementation references](docs/acp-reliability.md), and [model synchronization fixes](docs/acp-model-sync-fix.md).

## Notes

- Use trusted workspaces and extensions only: tools execute through Pi without an OS sandbox. Direct execution remains the default; optional Tool policy applies to Pi tool calls, not arbitrary extension code. A displayed diff is not itself an approval gate.
- Do not let multiple clients write to the same session history simultaneously. Bridge processes sharing a lease directory reject a second writer; stock Pi CLI does not honor this lease. Stop the ACP agent before resuming in Pi, and exit Pi before loading the session back in ACP.
- `session/delete` permanently removes the Pi history file and bridge index entry. Air in IDEs 262.8665.497 invokes it from **Done**; `session/close` only releases resources. Generated image assets are retained.
- See [client compatibility](docs/air-integration.md) for UI limitations and [protocol scope](docs/protocol.md) for supported ACP features.

This is an independent integration, not an official JetBrains product.
