<p align="center">
  <img src="assets/icon.svg" alt="Pi ACP Bridge icon" width="112" height="112">
</p>

# Pi ACP Bridge

Use Pi in ACP-compatible IDEs. Built on the official Pi TypeScript SDK, the bridge runs Pi in-process and communicates with the IDE over stdio—no separate Pi process or background service required.

## Features

- Streaming text and reasoning, model selection, and Thinking controls.
- Persistent workspace sessions with resume support.
- Tool execution, structured file diffs, image input, and tool image output.
- Slash commands, skill completion, and native interaction forms.
- Client-provided stdio and Streamable HTTP MCP servers.

UI support varies by client. See the [integration guide](docs/air-integration.md) for compatibility and validation notes.

## Quick start

Prepare **Node.js 22.19+** through mise and **pnpm 12.9.1**, then clone and build:

```sh
git clone https://github.com/Raiden49/pi_acp_bridge.git
cd pi_acp_bridge
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
```

The output is a standalone bundle at `dist/index.js`. It requires Node, but no adjacent `node_modules`. User-configured extensions and their external resources must still be available.

Configure your models and credentials in Pi before chatting. The bridge uses `~/.pi/agent/` by default; set `PI_CODING_AGENT_DIR` to use another profile. ACP login is not implemented.

## IDE configuration

For JetBrains Air in IDEs, add an entry to `~/.jetbrains/acp.json`, preserving any existing agents:

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

The repository icon is at `assets/icon.svg`. The inspected Air in IDEs custom-agent configuration does not support an `icon` field; registry icons use a separate mechanism.

Use absolute paths: GUI applications may not inherit your shell's PATH or API-key environment variables. The IDE supplies the workspace directory through ACP; do not hardcode it in the launch command.

For Zed, add the same entry under `agent_servers` in its settings, with `"type": "custom"` inside the entry. Standalone JetBrains Air uses a different configuration location; see the [integration guide](docs/air-integration.md).

## Update

Finish active agent tasks, then run:

```sh
./update.sh
# Or explicitly select an installed mise runtime:
mise exec node@22.22.0 -- ./update.sh
```

The script checks runtime versions and repository state, pulls the current branch's upstream with `--ff-only`, installs locked local dependencies, type-checks, and builds. It requires a clean working tree and does not install global tools or modify IDE settings, credentials, or chat history. Failures stop the update without automatically rolling back source, dependencies, or build output.

**Restart the IDE's agent process after updating.** `/reload` reloads Pi resources, not bridge code. IDE paths can stay unchanged while the repository and Node locations remain the same.

## Usage notes

- Use trusted workspaces only. Tools execute through Pi; workspace isolation is **not a filesystem sandbox**, and a displayed diff is not an approval gate.
- Close the previous client before resuming the same session elsewhere. Do not let multiple processes write to the same session history.
- Native forms require client support for `elicitation.form`. Images require a vision-capable model; rendering depends on the IDE.
- stdout is reserved for ACP messages. The bundle is not an interactive terminal chat application.

## Documentation

- [Build and distribution](docs/releasing.md)
- [IDE integration and troubleshooting](docs/air-integration.md)
- [Protocol scope and testing](docs/protocol.md)

This is an independent integration, not an official JetBrains product.
