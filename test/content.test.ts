import { expect, test } from "vitest";
import { decodePrompt } from "../src/content.js";

test("embedded editor context retains URI fragments and MIME provenance without fetching links", () => {
  const { text } = decodePrompt([
    { type: "text", text: "Compare these selections" },
    { type: "resource", resource: { uri: "file:///workspace/a.ts#L3-L5", mimeType: "text/typescript", text: "const selected = 1;" } },
    { type: "resource", resource: { uri: "file:///workspace/b.ts#L8", text: "const selected = 2;" } },
    { type: "resource_link", uri: "https://example.invalid/not-fetched", name: "Reference", title: "API example", description: "Selected documentation", mimeType: "text/html" },
  ]);
  for (const expected of ["file:///workspace/a.ts#L3-L5", "text/typescript", "const selected = 1;", "file:///workspace/b.ts#L8", "API example", "Selected documentation"]) {
    expect(text).toContain(expected);
  }
});
