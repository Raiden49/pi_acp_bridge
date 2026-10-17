<p align="center">
  <img src="assets/icon.svg" alt="Pi ACP Bridge icon" width="112" height="112">
</p>

# Pi ACP Bridge

Use [Pi](https://github.com/badlogic/pi-mono) in ACP-compatible IDEs. Built on the Pi TypeScript SDK, with no separate Pi process or background service required.

Supports streaming responses and reasoning, model and Thinking selection, Pi history discovery and resume, tools and file diffs, slash commands, images, native forms, and client-provided MCP servers. UI support varies by client.

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

**Restart the client's agent process afterward.** `/reload` reloads Pi resources, not bridge code.

## Notes

- Use trusted workspaces only: tools execute through Pi without a filesystem sandbox. A displayed diff is not an approval gate.
- Do not let multiple clients write to the same session history simultaneously. Bridge processes sharing a lease directory reject a second writer; stock Pi CLI does not honor this lease. Stop the ACP agent before resuming in Pi, and exit Pi before loading the session back in ACP.
- `session/delete` permanently removes the Pi history file and bridge index entry. Air in IDEs 262.8665.497 invokes it from **Done**; `session/close` only releases resources. Generated image assets are retained.
- See [client compatibility](docs/air-integration.md) for UI limitations and [protocol scope](docs/protocol.md) for supported ACP features.

This is an independent integration, not an official JetBrains product.
