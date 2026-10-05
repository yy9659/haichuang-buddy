import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getServerEnv, isAiConfigured, resetServerEnvCache } from "./env";

beforeEach(() => {
  resetServerEnvCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerEnvCache();
});

describe("新克隆项目的环境模板", () => {
  it("未启用的凭证留空时，Mock 和本地数据配置仍可读取", () => {
    vi.stubEnv("DATA_SOURCE", "local");
    vi.stubEnv("AI_PROVIDER", "mock");
    for (const key of [
      "DATABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY", "AI_API_KEY", "AI_BASE_URL", "DASHSCOPE_API_KEY",
      "DASHSCOPE_BASE_URL", "WANXIANG_API_KEY", "WANXIANG_BASE_URL", "AI_TIMEOUT_MS",
    ]) {
      vi.stubEnv(key, "");
    }
    vi.stubEnv("ADMIN_EMAILS", "");

    expect(getServerEnv()).toMatchObject({
      DATA_SOURCE: "local", AI_PROVIDER: "mock", ADMIN_EMAILS: "",
    });
    expect(getServerEnv().DATABASE_URL).toBeUndefined();
    expect(getServerEnv().DASHSCOPE_API_KEY).toBeUndefined();
    expect(isAiConfigured()).toBe(true);
  });

  it("空白密钥视为未配置，真实模型不能被误判为可用", () => {
    vi.stubEnv("AI_PROVIDER", "dashscope");
    vi.stubEnv("DASHSCOPE_API_KEY", "   ");
    vi.stubEnv("AI_API_KEY", "");
    expect(isAiConfigured()).toBe(false);
  });

  it("非法的非空枚举仍明确报错", () => {
    vi.stubEnv("DATA_SOURCE", "LOCAL");
    expect(() => getServerEnv()).toThrow("服务端环境变量配置不合法");
  });
});
