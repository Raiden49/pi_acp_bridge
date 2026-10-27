import { expect, test } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { protocolHarness } from "./protocol-harness.js";

test.each([true, false])("an unavailable or absent selection still offers working models: selected=%s", async (selected) => {
  const replacement = { provider: "fixture", id: "replacement", name: "Replacement" } as NonNullable<AgentSession["model"]>;
  const session = {
    model: selected ? { ...replacement, id: "removed" } : undefined,
    modelRuntime: { getAvailableSnapshot: () => [replacement] } as unknown as AgentSession["modelRuntime"],
    async setModel(model: typeof replacement) { this.model = model; },
    prompt: async () => {}, subscribe: () => () => {}, abort: async () => {}, dispose() {},
  };
  const client = protocolHarness(".scratch/absent-models.json", { createSession: async () => session });
  try {
    const opened = (await client.request("session/new", { cwd: "/workspace", mcpServers: [] })).result;
    const modelOption = opened.configOptions.find((option: { id: string }) => option.id === "model");
    expect(modelOption?.options).toContainEqual({ value: "fixture/replacement", name: "Replacement (fixture)" });
    const response = await client.request("session/set_config_option", { sessionId: opened.sessionId, configId: "model", value: "fixture/replacement" });
    expect(response.result.configOptions[0].currentValue).toBe("fixture/replacement");
  } finally { await client.close(); }
});
