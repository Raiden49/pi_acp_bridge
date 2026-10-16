import { expect, test } from "vitest";
import { ImageLinkStream } from "../src/image-links.js";

const cwd = "/workspace/project";

test.each([
  ["![机器人](/tmp/robot.jpg)", "[机器人](file:///tmp/robot.jpg)"],
  ["![机器人](.scratch/robot.png)", "[机器人](file:///workspace/project/.scratch/robot.png)"],
  ["![图](<./a b(1).png>)", "[图](file:///workspace/project/a%20b%281%29.png)"],
  ['![图](./robot.png "title")', '[图](file:///workspace/project/robot.png "title")'],
  ["![图](file:///tmp/robot.jpg)", "[图](file:///tmp/robot.jpg)"],
  ["![图](https://example.com/a.png)", "![图](https://example.com/a.png)"],
  ["`![图](/tmp/a.png)`\n```md\n![图](/tmp/a.png)\n```", "`![图](/tmp/a.png)`\n```md\n![图](/tmp/a.png)\n```"],
  ["\\![图](/tmp/a.png) and unfinished ![图](", "\\![图](/tmp/a.png) and unfinished ![图]("],
])("normalizes local image links without depending on chunk boundaries: %s", (input, expected) => {
  for (const chunks of [[input], [...input]]) {
    const stream = new ImageLinkStream(cwd);
    expect(chunks.map((chunk) => stream.push(chunk)).join("") + stream.finish()).toBe(expected);
  }
});

test("streams ordinary prose immediately and flushes unfinished markup unchanged", () => {
  const stream = new ImageLinkStream(cwd);
  expect(stream.push("hello ")).toBe("hello ");
  expect(stream.push("![image](")).toBe("");
  expect(stream.finish()).toBe("![image](");
});
