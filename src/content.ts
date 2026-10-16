import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RequestError, type ContentBlock } from "@agentclientprotocol/sdk";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

type Image = NonNullable<NonNullable<Parameters<AgentSession["prompt"]>[1]>["images"]>[number];

export function decodePrompt(blocks: ContentBlock[]) {
  const text: string[] = [];
  const images: Image[] = [];
  for (const block of blocks) {
    if (block.type === "text") text.push(block.text);
    else if (block.type === "image" || (block.type === "resource_link" && block.mimeType?.startsWith("image/"))) {
      try {
        const mimeType = block.mimeType!;
        const data = block.type === "image" && block.data ? block.data
          : readFileSync(fileURLToPath(block.type === "image" ? block.uri! : block.uri)).toString("base64");
        if (!mimeType.startsWith("image/") || !data || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
          throw new Error("Invalid image");
        }
        images.push({ type: "image", data, mimeType });
      } catch { throw RequestError.invalidParams("Image requires base64 data or a readable local file URI"); }
    } else if (block.type === "resource_link") text.push(`[${block.name}](${block.uri})`);
    else if (block.type === "resource" && "text" in block.resource) text.push(block.resource.text);
    else throw RequestError.invalidParams("Unsupported prompt content");
  }
  return { text: text.join("\n"), images };
}

export async function imageLink(image: Image, artifactDir: string): Promise<ContentBlock> {
  const bytes = Buffer.from(image.data, "base64");
  const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" } as Record<string, string>)[image.mimeType] ?? "img";
  const name = `${createHash("sha256").update(bytes).digest("hex")}.${extension}`;
  await mkdir(artifactDir, { recursive: true });
  const path = join(artifactDir, name);
  await writeFile(path, bytes, { mode: 0o600 });
  // Some ACP clients stringify non-text assistant chunks, exposing image base64.
  // Keep native images in tool results; present a portable file link in chat.
  const uri = pathToFileURL(path).href;
  return { type: "text", text: `\n\n[打开图片](${uri})\n\n图片文件：\`${fileURLToPath(uri)}\`\n\n` };
}
