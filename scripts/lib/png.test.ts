/**
 * PNG 编码器单测
 *
 * 自己实现的编码器一旦有字节级错误，浏览器只会显示一张裂图、不给任何提示，
 * 所以这里按 PNG 规范逐段校验结构，并把 IDAT 解压出来核对真实像素。
 */

import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { encodePng } from "./png";
import { SAMPLE_PALETTES, renderSampleProductImage } from "./sample-image";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

interface PngChunk {
  type: string;
  data: Buffer;
}

/** 按 PNG 规范遍历所有块（length + type + data + crc） */
function readChunks(png: Buffer): PngChunk[] {
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    chunks.push({
      type,
      data: png.subarray(offset + 8, offset + 8 + length),
    });
    offset += 12 + length;
  }
  return chunks;
}

describe("encodePng", () => {
  it("写出合法签名、IHDR 与 IEND", () => {
    const png = encodePng(3, 2, () => [10, 20, 30]);

    expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);

    const chunks = readChunks(png);
    const types = chunks.map((chunk) => chunk.type);
    expect(types[0]).toBe("IHDR");
    expect(types[types.length - 1]).toBe("IEND");

    const ihdr = chunks[0]?.data;
    expect(ihdr).toBeDefined();
    if (!ihdr) {
      return;
    }
    expect(ihdr.readUInt32BE(0)).toBe(3); // width
    expect(ihdr.readUInt32BE(4)).toBe(2); // height
    expect(ihdr[8]).toBe(8); // bit depth
    expect(ihdr[9]).toBe(2); // color type: truecolor
    expect(ihdr[10]).toBe(0); // compression: deflate
    expect(ihdr[11]).toBe(0); // filter: none
    expect(ihdr[12]).toBe(0); // interlace: none
  });

  it("IDAT 解压后的字节数与像素完全对应", () => {
    const png = encodePng(3, 2, (x) => [x * 10, 0, 0]);
    const chunks = readChunks(png);
    const idat = chunks.filter((chunk) => chunk.type === "IDAT");
    expect(idat.length).toBeGreaterThan(0);

    const raw = inflateSync(Buffer.concat(idat.map((chunk) => chunk.data)));
    // 每行 = 1 字节 filter + width * 3 字节 RGB
    expect(raw.length).toBe(2 * (1 + 3 * 3));

    // 第一行：filter=0，然后 (0,0,0) (10,0,0) (20,0,0)
    expect([...raw.subarray(0, 10)]).toEqual([0, 0, 0, 0, 10, 0, 0, 20, 0, 0]);
    // 第二行结构相同
    expect(raw[10]).toBe(0);
    expect([...raw.subarray(11, 20)]).toEqual([0, 0, 0, 10, 0, 0, 20, 0, 0]);
  });

  it("通道值被裁剪到 0-255，非法值不会写坏字节", () => {
    const png = encodePng(1, 1, () => [-20, 999, Number.NaN]);
    const chunks = readChunks(png);
    const idat = chunks.filter((chunk) => chunk.type === "IDAT");
    const raw = inflateSync(Buffer.concat(idat.map((chunk) => chunk.data)));
    expect([...raw]).toEqual([0, 0, 255, 0]);
  });
});

describe("renderSampleProductImage", () => {
  it("生成 1200×900 的合法 PNG", () => {
    const png = renderSampleProductImage({
      palette: SAMPLE_PALETTES.seafood,
      seed: 1,
      bubbleCount: 4,
    });
    const chunks = readChunks(png);
    const ihdr = chunks[0]?.data;
    expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(ihdr?.readUInt32BE(0)).toBe(1200);
    expect(ihdr?.readUInt32BE(4)).toBe(900);
  });

  it("同一 seed 输出完全一致（seed 可复现）", () => {
    const first = renderSampleProductImage({
      palette: SAMPLE_PALETTES.dried,
      seed: 42,
      width: 80,
      height: 60,
    });
    const second = renderSampleProductImage({
      palette: SAMPLE_PALETTES.dried,
      seed: 42,
      width: 80,
      height: 60,
    });
    expect(first.equals(second)).toBe(true);
  });

  it("不同调色板输出不同图片", () => {
    const seafood = renderSampleProductImage({
      palette: SAMPLE_PALETTES.seafood,
      seed: 7,
      width: 64,
      height: 48,
    });
    const dried = renderSampleProductImage({
      palette: SAMPLE_PALETTES.dried,
      seed: 7,
      width: 64,
      height: 48,
    });
    expect(seafood.equals(dried)).toBe(false);
  });
});
