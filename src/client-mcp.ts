import { RequestError, type McpServer } from "@agentclientprotocol/sdk";
import { createMcpExtension, type AgentSession, type ExtensionFactory, type McpServerEntry } from "@earendil-works/pi-coding-agent";
import { StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";

export function clientMcpEntries(servers: McpServer[]): McpServerEntry[] {
  const names = new Set<string>();
  return servers.map((server) => {
    const namespace = server.name.replace(/-/g, "_");
    if (!/^[a-zA-Z0-9_-]+$/.test(server.name) || names.has(namespace)) {
      throw RequestError.invalidParams("MCP server names must be unique namespaces using letters, digits, underscores or hyphens");
    }
    names.add(namespace);
    if ("type" in server && server.type !== "http") {
      throw RequestError.invalidParams("Only stdio and Streamable HTTP MCP servers are supported");
    }
    return {
      name: server.name, source: "acp-client", scope: "extension",
      config: "command" in server
        ? { command: server.command, args: server.args, env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])), exposure: "direct" }
        : { type: "http", url: server.url, headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])), exposure: "direct" },
    };
  });
}

export function clientMcpExtension(servers: McpServer[]): ExtensionFactory {
  const entries = clientMcpEntries(servers);
  return createMcpExtension({
    loadConfig: () => ({ servers: entries, errors: [], autoEnableCodemode: false }),
    // ACP env and header values are literal, not Pi config interpolation or shell commands.
    createTransport(entry, cwd) {
      const config = entry.config;
      return "command" in config
        ? new StdioTransport({ command: config.command, args: config.args, env: config.env, cwd })
        : new StreamableHttpTransport({ url: config.url, headers: config.headers });
    },
    updateConfig: () => { throw new Error("Client MCP configuration is managed by the IDE"); },
  });
}

export async function shutdownSession(session: Partial<Pick<AgentSession, "extensionRunner">>) {
  await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
}
