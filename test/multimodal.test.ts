import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  const trace = vi.fn();
  const client = protocolHarness(".scratch/absent-models.json", { trace, createSession: async () => ({
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
    expect(trace.mock.calls.map(([event]) => event.event)).toEqual([
      "session_open", "session_ready", "prompt_received", "prompt_decoded", "prompt_dispatched", "prompt_settled",
    ]);
    expect(trace).toHaveBeenCalledWith(expect.objectContaining({ event: "prompt_decoded", images: 2, imageBase64Length: png.length * 2 }));
    expect(await client.request("session/prompt", { sessionId, prompt: [
      { type: "image", data: "not-base64", mimeType: "image/png" },
    ] })).toMatchObject({ error: { code: -32602 } });
    expect(trace).toHaveBeenLastCalledWith({ event: "prompt_rejected", sessionId, code: -32602 });
    expect(prompt).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(trace.mock.calls);
    for (const secret of ["Compare", png, path, "not-base64"]) expect(logged).not.toContain(secret);
  } finally { await client.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("keeps native tool images with navigable artifacts and normalizes model-authored image links", async () => {
  await mkdir(".scratch", { recursive: true });
  const artifactDir = await mkdtemp(resolve(".scratch/artifacts with space-"));
  let listener: Parameters<AgentSession["subscribe"]>[0] = () => {};
  const client = protocolHarness(".scratch/absent-models.json", { artifactDir, createSession: async () => ({
    subscribe(fn) { listener = fn; return () => {}; }, abort: async () => {}, dispose() {},
    async prompt() {
      listener({ type: "tool_execution_start", toolCallId: "image", toolName: "read", args: {} });
      listener({ type: "tool_execution_end", toolCallId: "image", toolName: "read", isError: false,
        result: { content: [{ type: "image", data: png, mimeType: "image/png" }], details: {} } });
      for (const delta of ["![robot](/tmp/", "robot.jpg)"]) {
        listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } } as Parameters<typeof listener>[0]);
      }
    },
  }) });
  try {
    const { sessionId } = (await client.request("session/new", { cwd: artifactDir, mcpServers: [] })).result;
    expect(await client.request("session/prompt", { sessionId, prompt: [] })).toHaveProperty("result");
    expect((await client.nextNotification()).params.update.sessionUpdate).toBe("tool_call");
    const tool = (await client.nextNotification()).params.update;
    expect(tool.content[0]).toEqual({ type: "content", content: { type: "image", data: png, mimeType: "image/png" } });
    const link = tool.content[1]?.content;
    expect(link?.type).toBe("text");
    expect(link.text).not.toContain(png);
    const uri = link.text.match(/\]\((file:\/\/\/[^)]+)\)/)?.[1];
    expect(uri).toContain("artifacts%20with%20space-");
    expect(await readFile(new URL(uri!))).toEqual(Buffer.from(png, "base64"));
    expect(link.text).toContain(artifactDir);
    expect(tool.locations).toEqual(expect.arrayContaining([{ path: fileURLToPath(uri!) }]));
    expect((await client.nextNotification()).params.update.content).toEqual({
      type: "text", text: "[robot](file:///tmp/robot.jpg)",
    });
  } finally { await client.close(); await rm(artifactDir, { recursive: true, force: true }); }
});
