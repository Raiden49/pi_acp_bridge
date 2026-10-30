<p align="center">
  <img src="assets/icon.svg" alt="Pi ACP Bridge icon" width="112" height="112">
</p>

# Pi ACP Bridge

Use [Pi](https://github.com/earendil-works/pi) in ACP-compatible IDEs. Built on the Pi TypeScript SDK; no separate Pi process required.

## Install

Requires **Node.js 22.19+** and **pnpm 12.9.1**. Configure models and credentials in Pi first.

```sh
git clone https://github.com/Raiden49/pi_acp_bridge.git
cd pi_acp_bridge
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
```

Uses `~/.pi/agent/` by default. Set `PI_CODING_AGENT_DIR` to use another profile.

## Connect your IDE

### CLion / PyCharm — Air in IDEs

On macOS, generate a local registry with the Node runtime you want to use:

```sh
node scripts/create-local-registry.mjs
```

Quit the IDE and back up `~/Library/Application Support/JetBrains/<product-and-version>/options/ide.general.xml`. Add this entry inside `<component name="Registry">`, preserving existing settings:

```xml
<entry key="air.acp.registry.path"
       value="/absolute/path/to/pi_acp_bridge/.scratch/local-registry/registry.json"
       source="USER" />
```

Create the `Registry` component inside `<application>` if absent. Restart the IDE, install **Pi Bridge** from Air's agent catalog, and start a new chat. Requires a plugin version supporting `air.acp.registry.path`.

Keep `.scratch/local-registry/`; rerun the script to refresh its catalog snapshot.

### Air Desktop / Zed

Add this entry to `agent_servers` in Air Desktop's `~/Library/Application Support/JetBrains/Air/acp.json`, or in Zed settings:

```json
{
  "agent_servers": {
    "Pi Bridge": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/pi_acp_bridge/dist/index.js"]
    }
  }
}
```

Use absolute paths; `node -p 'process.execPath'` prints the Node path. For Zed, also add `"type": "custom"` to the entry. Restart the client and select **Pi Bridge**.

## Update

With a clean working tree, run:

```sh
./update.sh
```

Restart the agent afterward. `/reload` refreshes Pi configuration, not bridge code. Keep all three files in `dist/` together.

## Notes

- `/session` shows session information; `/doctor` helps diagnose configuration issues.
- Use trusted workspaces and extensions only. Tools execute locally without an OS sandbox.
- Do not open the same history for writing in Pi CLI and the bridge simultaneously. `session/delete` permanently deletes that history.

协议修复、会话发现的性能边界和验证范围见 [ACP v1 审计记录](docs/acp-v1-audit.md)。

Independent integration; not an official JetBrains product.
