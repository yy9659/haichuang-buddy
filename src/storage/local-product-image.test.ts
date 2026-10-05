import { describe, expect, it } from "vitest";

import { GET } from "@/app/api/product-images/[filename]/route";

import {
  localProductImageFilename,
  removeLocalProductImage,
  saveLocalProductImage,
} from "./local-product-image";

describe("本地商品图片", () => {
  it("连续保存两张大图片时只返回短地址，并能分别读取", async () => {
    const urls: string[] = [];
    try {
      for (const fill of [17, 83]) {
        const saved = await saveLocalProductImage({
          data: new Uint8Array(5 * 1024 * 1024).fill(fill),
          contentType: "image/png",
          name: "商品",
        });
        expect(saved.ok).toBe(true);
        if (!saved.ok) return;
        urls.push(saved.data.url);
        expect(saved.data.url.length).toBeLessThan(80);
      }

      expect(urls[0]).not.toBe(urls[1]);
      for (const [index, url] of urls.entries()) {
        const filename = localProductImageFilename(url);
        expect(filename).toBeTruthy();
        if (!filename) continue;
        const response = await GET(new Request(`http://localhost${url}`), {
          params: Promise.resolve({ filename }),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("image/png");
        const data = new Uint8Array(await response.arrayBuffer());
        expect(data.byteLength).toBe(5 * 1024 * 1024);
        expect(data[0]).toBe([17, 83][index]);
      }
    } finally {
      await Promise.all(urls.map((url) => removeLocalProductImage(url)));
    }
  });

  it("拒绝含路径穿越的图片名", async () => {
    const response = await GET(new Request("http://localhost/api/product-images/secret"), {
      params: Promise.resolve({ filename: "../secret" }),
    });
    expect(response.status).toBe(404);
  });
});
