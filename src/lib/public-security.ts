import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { getServerEnv } from "@/lib/env";
import { AppError } from "@/lib/result";

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function configuredAppOrigin(): URL | null {
  const value = getServerEnv().APP_ORIGIN;
  if (!value) return null;
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && localHosts.has(url.hostname)))) {
    throw new AppError({ code: "VALIDATION_FAILED", message: "APP_ORIGIN 必须是 HTTPS 站点源地址；仅本机允许 HTTP。" });
  }
  return url;
}

export function trustedClientSource(headers: Pick<Headers, "get">, secret?: string): string {
  if (!secret) return "shared";
  const actual = Buffer.from(headers.get("x-buddy-proxy-proof") ?? "");
  const expected = Buffer.from(secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AppError({ code: "UNAUTHORIZED", message: "请求没有经过已配置的可信代理。" });
  }
  const ip = headers.get("x-buddy-client-ip") ?? "";
  if (isIP(ip) === 4) return ip;
  if (isIP(ip) === 6 && !ip.includes("%")) {
    const normalized = new URL("http://[" + ip + "]/").hostname;
    const mapped = /^\[::ffff:([a-f\d]+):([a-f\d]+)\]$/.exec(normalized);
    if (mapped) {
      const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
      return [high >> 8, high & 255, low >> 8, low & 255].join(".");
    }
    // Group rotating privacy addresses in the same IPv6 /64.
    const [left, right] = normalized.slice(1, -1).split("::");
    const prefix = left ? left.split(":") : [];
    const tail = right ? right.split(":") : [];
    const words = right === undefined ? prefix : [...prefix, ...Array(8 - prefix.length - tail.length).fill("0"), ...tail];
    return words.slice(0, 4).join(":") + "::/64";
  }
  return "shared";
}
