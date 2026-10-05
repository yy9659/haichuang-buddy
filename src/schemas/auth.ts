/**
 * 注册 / 登录 的输入校验
 *
 * 用户输入进入系统的唯一闸门。这里的每一条规则都会**改变**用户看到的第一句话，
 * 所以注释写的是「为什么是这条规则」。
 */

import { z } from "zod";

/** 密码长度下限。8 位是行业通行的底线；再低不值得写进产品 */
export const PASSWORD_MIN_LENGTH = 8;

/**
 * 密码长度上限。
 *
 * scrypt 的开销与输入长度无关（它先做一次哈希），所以这里不是因为性能 ——
 * 而是为了挡住「提交一个 10MB 的字符串」这类请求在 JSON 解析与日志里把
 * 内存和磁盘打满。128 对任何真人密码都绰绰有余。
 */
export const PASSWORD_MAX_LENGTH = 128;

/** 昵称长度上限（界面上的展示名） */
const NAME_MAX_LENGTH = 32;

/**
 * 邮箱字段。
 *
 * - `toLowerCase()` 在**校验之前**做：否则 `Foo@x.com` 与 `foo@x.com` 会是两个账号，
 *   而用户完全不觉得自己注册了两次。归一化放在这里而不是仓储，
 *   是因为「邮箱大小写不敏感」是一条**业务规则**，不是存储细节。
 * - 刻意**不**用「允许列表」去限制邮箱域名：那只会挡住合法的企业邮箱。
 */
const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("请输入有效的邮箱地址"));

export const registerSchema = z.object({
  email: emailField,
  name: z
    .string()
    .trim()
    .min(1, "请填写称呼")
    .max(NAME_MAX_LENGTH, `称呼请控制在 ${NAME_MAX_LENGTH} 字以内`),
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `密码至少 ${PASSWORD_MIN_LENGTH} 位`)
    .max(PASSWORD_MAX_LENGTH, `密码请控制在 ${PASSWORD_MAX_LENGTH} 位以内`),
});

export type RegisterInput = z.infer<typeof registerSchema>;

/**
 * 登录字段。
 *
 * 这里**故意不校验密码长度**：长度规则属于「设置密码」时的事。
 * 登录时把「密码至少 8 位」当成校验错误抛出去，等于告诉攻击者
 * 「这个账号的密码不足 8 位」——顺手泄露了密码强度信息。
 * 登录只有两种结果：成功，或者「邮箱或密码不正确」。
 */
export const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1, "请输入密码").max(PASSWORD_MAX_LENGTH),
});

export type LoginInput = z.infer<typeof loginSchema>;
