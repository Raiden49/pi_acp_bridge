import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Normalize inline local Markdown images while keeping ordinary prose streaming. */
export class ImageLinkStream {
  private pending = "";
  private code = "";
  constructor(private cwd: string) {}

  push(text: string): string {
    this.pending += text;
    let output = "";
    while (this.pending) {
      const value = this.pending;
      if (value[0] === "`") {
        const ticks = value.match(/^`+/)![0];
        if (ticks.length === value.length) break;
        if (!this.code) this.code = ticks;
        else if (this.code === ticks) this.code = "";
        output += ticks;
        this.pending = value.slice(ticks.length);
        continue;
      }
      if (!this.code && value[0] === "\\") {
        if (value.length === 1) break;
        output += value.slice(0, 2);
        this.pending = value.slice(2);
        continue;
      }
      if (!this.code && value[0] === "!") {
        if (value.length === 1) break;
        if (value[1] === "[") {
          const label = value.match(/^!\[((?:\\.|[^\]\\\n])*)\]/);
          if (!label && !value.includes("\n")) break;
          if (label) {
            const start = label[0].length;
            if (value.length === start) break;
            if (value[start] === "(") {
              let depth = 1, angle = false, quote = "", end = start + 1;
              for (; end < value.length; end++) {
                const char = value[end]!;
                if (char === "\\") { end++; continue; }
                if (quote) { if (char === quote) quote = ""; continue; }
                if (angle) { if (char === ">") angle = false; continue; }
                if (char === "<" && end === start + 1) angle = true;
                else if ((char === '"' || char === "'") && /\s/.test(value[end - 1]!)) quote = char;
                else if (char === "(") depth++;
                else if (char === ")" && --depth === 0) break;
                else if (char === "\n") break;
              }
              if (end >= value.length) break;
              if (depth === 0) {
                output += this.normalize(label[1]!, value.slice(start + 1, end), value.slice(0, end + 1));
                this.pending = value.slice(end + 1);
                continue;
              }
            }
          }
        }
      }
      output += value[0];
      this.pending = value.slice(1);
    }
    return output;
  }

  finish(): string {
    const text = this.pending;
    this.pending = "";
    this.code = "";
    return text;
  }

  private normalize(label: string, target: string, original: string): string {
    const match = target.startsWith("<") ? target.match(/^<([^>]*)>(.*)$/) : target.match(/^((?:\\.|[^\s])+)(.*)$/);
    if (!match) return original;
    const path = match[1]!.replace(/\\([\\()[\] ])/g, "$1");
    if (!path || path.startsWith("//") || path.startsWith("#")) return original;
    if (/^[a-z][a-z\d+.-]*:/i.test(path) && !path.startsWith("file:///")) return original;
    const uri = (path.startsWith("file:///") ? path : pathToFileURL(resolve(this.cwd, path)).href)
      .replace(/\(/g, "%28").replace(/\)/g, "%29");
    return `[${label || "打开图片"}](${uri}${match[2]})`;
  }
}
