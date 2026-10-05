import { getDataSource } from "@/lib/env";
import type { SearchRepository } from "@/types/search";
import { createDbSearchRepository } from "./db/search.repository";
import { createMockSearchRepository } from "./mock/search";

export function getSearchRepository(): SearchRepository {
  return getDataSource() === "mock" ? createMockSearchRepository() : createDbSearchRepository();
}
