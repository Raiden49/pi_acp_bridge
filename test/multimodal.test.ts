import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { protocolHarness } from "./protocol-harness.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

test("passes inline and file-linked images to Pi and advertises vision support", async () => {
  await mkdir(".scratch", { recursive: true });
  const cwd = await mkdtemp(resolve(".scratch/images-"));
  const path = resolve(cwd, "pixel.png");
  await writeFile(path, Buffer.from(png, "base64"));
  const prompt = vi.fn(async () => {});
  const client = protocolHarness(".scratch/absent-models.json", { createSession: async () => ({
    prompt, subscribe: () => () => {}, abort: async () => {}, dispose() {},
  }) });
  try {
    expect((await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} })).result.agentCapabilities)
      .toMatchObject({ promptCapabilities: { image: true, embeddedContext: true } });
    const { sessionId } = (await client.request("session/new", { cwd, mcpServers: [] })).result;
    expect(await client.request("session/prompt", { sessionId, prompt: [
      { type: "text", text: "Compare" }, { type: "image", data: png, mimeType: "image/png" },
      { type: "resource_link", uri: pathToFileURL(path).href, name: "pixel", mimeType: "image/png" },
    ] })).toMatchObject({ result: { stopReason: "end_turn" } });
    expect(prompt).toHaveBeenCalledWith("Compare", { images: [
      { type: "image", data: png, mimeType: "image/png" }, { type: "image", data: png, mimeType: "image/png" },
    ] });
  } finally { await client.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("keeps native tool images but presents assistant images as readable absolute links", async () => {
  await mkdir(".scratch", { recursive: true });
  const artifactDir = await mkdtemp(resolve(".scratch/artifacts with space-"));
  let listener: Parameters<AgentSession["subscribe"]>[0] = () => {};
  const client = protocolHarness(".scratch/absent-models.json", { artifactDir, createSession: async () => ({
    subscribe(fn) { listener = fn; return () => {}; }, abort: async () => {}, dispose() {},
    async prompt() {
      listener({ type: "tool_execution_end", toolCallId: "image", toolName: "read", isError: false,
        result: { content: [{ type: "image", data: png, mimeType: "image/png" }], details: {} } });
    },
  }) });
  try {
    const { sessionId } = (await client.request("session/new", { cwd: artifactDir, mcpServers: [] })).result;
    expect(await client.request("session/prompt", { sessionId, prompt: [] })).toHaveProperty("result");
    const tool = (await client.nextNotification()).params.update;
    expect(tool.content[0]).toEqual({ type: "content", content: { type: "image", data: png, mimeType: "image/png" } });
    const update = (await client.nextNotification()).params.update;
    expect(update).toMatchObject({ sessionUpdate: "agent_message_chunk", content: { type: "text" } });
    expect(update.content.text).not.toContain(png);
    const uri = update.content.text.match(/\]\((file:\/\/\/[^)]+)\)/)?.[1];
    expect(uri).toContain("artifacts%20with%20space-");
    expect(await readFile(new URL(uri!))).toEqual(Buffer.from(png, "base64"));
    expect(update.content.text).toContain(artifactDir);
  } finally { await client.close(); await rm(artifactDir, { recursive: true, force: true }); }
});
