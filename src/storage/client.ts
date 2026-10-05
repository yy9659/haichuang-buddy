/**
 * Supabase 服务端客户端（Storage / 后续 RAG 建库共用）
 *
 * 设计要点：
 * - 使用 service_role key，拥有绕过 RLS 的权限，**只能出现在服务端**。
 *   因此本模块不允许被客户端组件 import（文件顶部不写 "use client"，
 *   并在服务端调用链上使用）。
 * - 惰性创建：只有真正调用 getSupabaseAdmin() 时才读环境变量，
 *   缺少凭证不会阻断 `next build`。
 * - 单例挂在 globalThis，避免开发模式热更新反复建连接。
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getServerEnv, isStorageConfigured } from "@/lib/env";
import { AppError } from "@/lib/result";

const globalForSupabase = globalThis as unknown as {
  __haichuangSupabase?: SupabaseClient;
};

/**
 * 获取具备写入权限的 Supabase 客户端。
 * 未配置 `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` 时抛 VALIDATION_FAILED。
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (globalForSupabase.__haichuangSupabase) {
    return globalForSupabase.__haichuangSupabase;
  }

  if (!isStorageConfigured()) {
    throw new AppError({
      code: "VALIDATION_FAILED",
      message: "尚未配置对象存储凭证",
      detail:
        "缺少环境变量：NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（请写入 .env.local）。",
      retryable: false,
    });
  }

  const env = getServerEnv();
  const client = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );

  globalForSupabase.__haichuangSupabase = client;
  return client;
}

/** Supabase 项目地址（用于拼公开 URL），未配置时返回 null */
export function getSupabaseProjectUrl(): string | null {
  return getServerEnv().NEXT_PUBLIC_SUPABASE_URL ?? null;
}
