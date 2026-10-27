import { RequestError, type McpServer } from "@agentclientprotocol/sdk";
import { createCodemodeExtension, createMcpExtension, createToolSearchExtension, type ExtensionFactory, type InlineExtension, type McpServerEntry } from "@earendil-works/pi-coding-agent";

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

// Match Pi CLI's named, replaceable built-ins so user replacements and
// -builtin:mcp settings keep their native meaning.
export function bridgeBuiltinExtensions(servers: McpServer[]): InlineExtension[] {
  return [
    { name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
    { name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
    { name: "mcp", factory: clientMcpExtension(servers), builtin: true, replaceable: true },
  ];
}

export function clientMcpExtension(servers: McpServer[]): ExtensionFactory {
  const entries = clientMcpEntries(servers);
  // Use the SDK's native loader, precedence, OAuth, reconnect and transports.
  // File configuration wins over registered servers, including '-'/'_' aliases.
  const extension = createMcpExtension();
  const literal = (value: string) => value.replaceAll("$", () => "$$").replace(/^!/, "$!");
  const questionTools = new Set(entries.map((entry) => `mcp__${entry.name.replace(/-/g, "_")}__ask_user_question`));
  return async (pi) => {
    for (const { name, config } of entries) {
      // Pi's config template escapes preserve ACP's literal values; never
      // interpret client credentials as !commands or $environment names.
      pi.registerMcpServer(name, "command" in config
        ? { ...config, env: Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => [key, literal(value)])) }
        : { ...config, headers: Object.fromEntries(Object.entries(config.headers ?? {}).map(([key, value]) => [key, literal(value)])) });
    }
    await extension(pi);
    pi.on("before_agent_start", (event) => {
      // Prefer only tools actually supplied by this client and active after discovery.
      const tool = pi.getActiveTools().find((name) => questionTools.has(name));
      if (tool) return { systemPrompt: `${event.systemPrompt}\nWhen asking the user a question, prefer the client's ${tool} tool over ask_user_question. Use other question tools only if the client tool is unavailable or fails.` };
    });
  };
}
