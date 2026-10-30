import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RequestError, type ContentBlock, type SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

type Image = NonNullable<NonNullable<Parameters<AgentSession["prompt"]>[1]>["images"]>[number];

// Pi's text signatures are provider-private fields, not ACP ContentBlock fields.
export function displayContent(content: { type: "text"; text: string } | Image): ContentBlock {
  return content.type === "text" ? { type: "text", text: content.text }
    : { type: "image", data: content.data, mimeType: content.mimeType };
}

function contextAttributes(fields: Record<string, string | null | undefined>) {
  const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
  return Object.entries(fields).filter(([, value]) => value != null)
    .map(([key, value]) => `${key}="${escape(value!)}"`).join(" ");
}

function decodeImage(value: string, mimeType: string): Image {
  const data = value.replace(/[\r\n]/g, "");
  if (!mimeType.startsWith("image/") || !data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw RequestError.invalidParams("Image requires base64 data and an image MIME type");
  }
  return { type: "image", data, mimeType };
}

export function decodePrompt(blocks: ContentBlock[]) {
  const text: string[] = [];
  const images: Image[] = [];
  for (const block of blocks) {
    if (block.type === "text") text.push(block.text);
    else if (block.type === "image") {
      images.push(decodeImage(block.data, block.mimeType));
    } else if (block.type === "resource_link") {
      text.push(`<resource_link ${contextAttributes({ ref: block.uri, name: block.name, title: block.title, mimeType: block.mimeType, description: block.description })} />`);
    } else if (block.type === "resource" && "text" in block.resource) {
      // Like Claude ACP, preserve the supplied reference beside embedded text.
      // Links are references only: never fetch arbitrary remote resources here.
      text.push(`<context ${contextAttributes({ ref: block.resource.uri, mimeType: block.resource.mimeType })}>\n${block.resource.text}\n</context>`);
    } else if (block.type === "resource" && "blob" in block.resource) {
      const { blob, mimeType, uri } = block.resource;
      if (mimeType?.startsWith("image/")) images.push(decodeImage(blob, mimeType));
      else text.push(`<context ${contextAttributes({ ref: uri, mimeType, encoding: "base64" })}>\n${blob}\n</context>`);
    } else throw RequestError.invalidParams("Unsupported prompt content");
  }
  return { text: text.join("\n"), images };
}

async function saveImage(image: Image, artifactDir: string) {
  const bytes = Buffer.from(image.data, "base64");
  const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" } as Record<string, string>)[image.mimeType] ?? "img";
  const name = `${createHash("sha256").update(bytes).digest("hex")}.${extension}`;
  await mkdir(artifactDir, { recursive: true });
  const path = join(artifactDir, name);
  await writeFile(path, bytes, { mode: 0o600 });
  // Some ACP clients stringify non-text assistant chunks, exposing image base64.
  // Keep native images in tool results; present a portable file link in chat.
  const uri = pathToFileURL(path).href;
  return { path, link: { type: "text" as const, text: `\n\n[打开图片](${uri})\n\n图片文件：\`${fileURLToPath(uri)}\`\n\n` } };
}

export async function imageLink(image: Image, artifactDir: string): Promise<ContentBlock> {
  return (await saveImage(image, artifactDir)).link;
}

export async function toolImageLinks(update: SessionUpdate, artifactDir: string): Promise<SessionUpdate> {
  if (update.sessionUpdate !== "tool_call_update" || !["completed", "failed"].includes(update.status ?? "")) return update;
  const images = (update.content ?? []).flatMap((block) => block.type === "content" && block.content.type === "image" ? [block.content] : []);
  if (!images.length) return update;
  const artifacts = await Promise.all(images.map((image) => saveImage(image, artifactDir)));
  return { ...update,
    content: [...update.content ?? [], ...artifacts.map(({ link }) => ({ type: "content" as const, content: link }))],
    locations: [...update.locations ?? [], ...artifacts.map(({ path }) => ({ path }))],
  };
}
