import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { protocolHarness } from "./protocol-harness.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture(config?: unknown) {
  await mkdir(".scratch", { recursive: true });
  const dir = await mkdtemp(resolve(".scratch/initialize-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const path = resolve(dir, "models.json");
  if (config !== undefined) await writeFile(path, JSON.stringify(config));
  const harness = protocolHarness(path);
  cleanup.push(() => harness.close());
  return { ...harness, path };
}

const params = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} };

test("initializes over NDJSON with metadata, supported version and fallback catalog", async () => {
  const client = await fixture();
  const response = await client.request("initialize", { ...params, protocolVersion: 999 });
  expect(response).toMatchObject({
    jsonrpc: "2.0", id: 1,
    result: {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: "pi-acp-bridge", version: "0.1.0" },
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true } },
      authMethods: [],
    },
  });
  expect(response.result._meta["pi-acp-bridge/models"]).toEqual(
    expect.arrayContaining([expect.objectContaining({
      modelId: expect.stringMatching(/^anthropic\//),
      name: expect.any(String),
    })]),
  );
});

test("discovers provider-qualified custom models and reloads edited configuration", async () => {
  const config = (id: string) => ({ providers: {
    enterprise: {
      baseUrl: "https://example.invalid/v1",
      api: "openai-completions",
      apiKey: "secret-do-not-advertise",
      models: [{ id, name: "Company model" }],
    },
  } });
  const client = await fixture(config("custom/model"));
  const first = await client.request("initialize", params);
  expect(first.result._meta["pi-acp-bridge/models"]).toContainEqual({
    modelId: "enterprise/custom/model", name: "Company model",
  });
  expect(JSON.stringify(first)).not.toContain("secret-do-not-advertise");
  await writeFile(client.path, JSON.stringify(config("replacement")));
  const second = await client.request("initialize", params);
  expect(second.result._meta["pi-acp-bridge/models"]).toContainEqual({
    modelId: "enterprise/replacement", name: "Company model",
  });
  expect(second.result._meta["pi-acp-bridge/models"]).not.toContainEqual({
    modelId: "enterprise/custom/model", name: "Company model",
  });
});

test("invalid model configuration returns an actionable protocol error without leaking contents", async () => {
  const client = await fixture();
  await writeFile(client.path, '{"secret-token":');
  const response = await client.request("initialize", params);
  expect(response.error).toMatchObject({ code: -32603, message: "Invalid Pi model configuration" });
  expect(JSON.stringify(response)).not.toContain("secret-token");
});

test("unimplemented authentication is explicitly rejected", async () => {
  const client = await fixture();
  await client.request("initialize", params);
  expect(await client.request("authenticate", { methodId: "unsupported" }))
    .toMatchObject({ error: { code: -32601 } });
});
