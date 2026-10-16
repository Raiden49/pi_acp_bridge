// Diagnostic ACP agent: no models, credentials, user tools, or network requests.
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { appendFileSync } from 'node:fs';

function chunk(type, data) {
  const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(128, 0); header.writeUInt32BE(128, 4);
header[8] = 8; header[9] = 6;
const pixels = Buffer.alloc(128 * (1 + 128 * 4));
for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
  const i = y * 513 + 1 + x * 4;
  pixels[i] = x < 64 ? 255 : 30;
  pixels[i + 1] = y < 64 ? 180 : 50;
  pixels[i + 2] = x < 64 ? 70 : 230;
  pixels[i + 3] = 255;
}
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
  chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
const imageUrl = new URL('../../.scratch/image-preview/fixture.png', import.meta.url);
await mkdir(new URL('.', imageUrl), { recursive: true });
await writeFile(imageUrl, png);
const record = (event, details = {}) => appendFileSync(new URL('./trace.ndjson', imageUrl),
  JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, ...details }) + '\n', { mode: 0o600 });
record('start');
const image = { type: 'image', mimeType: 'image/png', data: png.toString('base64') };
const cases = ['image', 'tool', 'markdown-file', 'markdown-data', 'link', 'resource'];
const connection = new AgentSideConnection((client) => ({
  async initialize({ clientInfo }) {
    record('initialize', { client: clientInfo?.name, version: clientInfo?.version });
    return { protocolVersion: PROTOCOL_VERSION, agentInfo: { name: 'image-preview-probe', version: '0.1.0' },
      agentCapabilities: {}, authMethods: [] };
  },
  async newSession() { record('session/new'); return { sessionId: 'image-preview-probe' }; },
  async prompt({ sessionId, prompt }) {
    const mode = prompt.filter((part) => part.type === 'text').map((part) => part.text).join(' ').trim();
    record('prompt', { mode: cases.includes(mode) ? mode : 'help' });
    const send = (update) => client.sessionUpdate({ sessionId, update });
    const text = (value) => send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });
    if (!cases.includes(mode)) await text(`输入一种测试：${cases.join(' / ')}。每次只测一种，不调用模型。\n`);
    else {
      await text(`图片展示测试：${mode}\n\n`);
      if (mode === 'tool') {
        const toolCallId = 'fixture-image';
        await send({ sessionUpdate: 'tool_call', toolCallId, title: '固定测试图片', kind: 'read', status: 'in_progress' });
        await send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed',
          content: [{ type: 'content', content: image }], locations: [{ path: fileURLToPath(imageUrl) }] });
      } else if (mode === 'image') await send({ sessionUpdate: 'agent_message_chunk', content: image });
      else if (mode === 'resource') await send({ sessionUpdate: 'agent_message_chunk',
        content: { type: 'resource_link', uri: imageUrl.href, mimeType: 'image/png', name: 'fixture.png' } });
      else if (mode === 'markdown-file') await text(`![测试图片](${imageUrl.href})\n`);
      else if (mode === 'markdown-data') await text(`![测试图片](data:image/png;base64,${image.data})\n`);
      else await text(`[打开测试图片](${imageUrl.href})\n`);
      await text('\n测试完成。请记录：正文预览 / 展开工具后预览 / 仅链接 / JSON / 无内容。\n');
    }
    record('completed', { mode: cases.includes(mode) ? mode : 'help' });
    return { stopReason: 'end_turn' };
  },
  async cancel() {},
}), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;
