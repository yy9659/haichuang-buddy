import { getDataSource } from "@/lib/env";
import { createDbPlatformRepository } from "./db/platform.repository";
import { createMockPlatformRepository } from "./mock/platform";
import type { PlatformRepository } from "@/types/admin";

export function getPlatformRepository(): PlatformRepository {
  return getDataSource() === "mock" ? createMockPlatformRepository() : createDbPlatformRepository();
}
