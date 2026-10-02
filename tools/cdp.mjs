/**
 * A very small DevTools-protocol client.
 *
 * Written out rather than pulled in as a dependency: the screenshot harness needs exactly one socket
 * and three methods, and a dev tool that adds a dependency to someone's project is a worse trade than
 * forty lines of buffer handling.
 *
 * WebSocket client frames must be masked per RFC 6455, which is why the mask is written even though
 * these are all zeros — the server rejects unmasked frames.
 */
import { createConnection } from 'node:net';

export class CDP {
  constructor(wsUrl) {
    const m = /^ws:\/\/([^:/]+):(\d+)(\/.*)$/.exec(wsUrl);
    if (!m) throw new Error(`Bad websocket url: ${wsUrl}`);
    this.host = m[1];
    this.port = Number(m[2]);
    this.path = m[3];
    this.id = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.onRaw = () => {};
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = Buffer.from(Math.random().toString(36).slice(2).repeat(2))
        .toString('base64')
        .slice(0, 24);

      this.sock = createConnection({ host: this.host, port: this.port }, () => {
        this.sock.write(
          `GET ${this.path} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\n` +
            `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      this.sock.on('error', reject);

      let handshake = false;
      this.sock.on('data', (chunk) => {
        if (!handshake) {
          const text = chunk.toString('latin1');
          const idx = text.indexOf('\r\n\r\n');
          if (idx === -1) return;
          handshake = true;
          const headerBytes = Buffer.byteLength(text.slice(0, idx + 4), 'latin1');
          const rest = chunk.subarray(headerBytes);
          if (rest.length) this.onData(rest);
          resolve();
        } else {
          this.onData(chunk);
        }
      });
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    for (;;) {
      if (this.buffer.length < 2) return;
      const opcode = this.buffer[0] & 0x0f;
      let len = this.buffer[1] & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.buffer.length < offset + len) return;

      const payload = this.buffer.subarray(offset, offset + len);
      this.buffer = this.buffer.subarray(offset + len);

      this.onRaw(payload.toString('utf8'));
      if (opcode !== 0x1) continue;

      let msg;
      try {
        msg = JSON.parse(payload.toString('utf8'));
      } catch {
        continue;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  }

  /** Builds a masked client frame, as the protocol requires. */
  frame(text) {
    const data = Buffer.from(text, 'utf8');
    const mask = Buffer.from([0, 0, 0, 0]);
    let header;

    if (data.length < 126) {
      header = Buffer.from([0x81, 0x80 | data.length]);
    } else if (data.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    return Buffer.concat([header, mask, data]);
  }

  /**
   * Sends one command and resolves its reply.
   *
   * `timeoutMs` is per call rather than fixed, because the work varies enormously by method. A single
   * `Runtime.evaluate` driving the game through a scripted control sequence legitimately takes minutes under
   * a software renderer, and a timeout sized for the shortest call would abandon it while a genuinely hung
   * command would then never be reported. Anything that legitimately needs longer passes it explicitly, so
   * the default still means "this should have been instant".
   */
  send(method, params = {}, timeoutMs = 60000) {
    const id = ++this.id;
    this.sock.write(this.frame(JSON.stringify({ id, method, params })));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  close() {
    this.sock?.end();
  }
}