import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveSafeLocalDatabaseDir } from "./demo-reset";

describe("demo:reset 路径安全", () => {
  const workspace = path.resolve("E:/workspace/haichuang-buddy");

  it("只允许项目 .data 下的具体数据库目录", () => {
    expect(
      resolveSafeLocalDatabaseDir({
        workspace,
        configured: ".data/pgdata-demo",
      }),
    ).toBe(path.resolve(workspace, ".data/pgdata-demo"));
  });

  it.each([".", ".data", "..", "../outside", "C:/outside/pgdata"])(
    "拒绝危险路径 %s",
    (configured) => {
      expect(() =>
        resolveSafeLocalDatabaseDir({ workspace, configured }),
      ).toThrow("拒绝删除不安全的数据目录");
    },
  );
});
