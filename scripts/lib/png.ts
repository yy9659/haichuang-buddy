/**
 * 极简 PNG 编码器（仅依赖 node:zlib）
 *
 * 为什么自己写：seed 需要上传"示例商品图片"，但为了生成三张占位图而引入
 * sharp / canvas 这类带原生依赖的包，会让安装体积与跨平台兼容性明显变差。
 * 24 位真彩色 PNG 的格式足够简单，这里用 60 行实现，零依赖且结果确定。
 */

import { deflateSync } from "node:zlib";

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuffer, Buffer.from(data)]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);

  return Buffer.concat([length, body, crc]);
}

export type Rgb = readonly [number, number, number];

function clampChannel(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * 生成 24 位真彩色 PNG。
 * @param pixel 返回 [r,g,b] 的取样函数，坐标为像素点
 */
export function encodePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => Rgb,
): Buffer {
  const bytesPerRow = 1 + width * 3;
  const raw = Buffer.alloc(height * bytesPerRow);

  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    // 每行首个字节是 filter type，0 表示不过滤
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[offset] = clampChannel(r);
      raw[offset + 1] = clampChannel(g);
      raw[offset + 2] = clampChannel(b);
      offset += 3;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
