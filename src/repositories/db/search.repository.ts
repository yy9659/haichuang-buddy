import { and, desc, eq, ilike, sql, type SQL } from "drizzle-orm";
import { ensureLocalDatabaseReady, getDb } from "@/db";
import { agentWorkflows, contents, products } from "@/db/schema";
import { escapeSearchLike, searchTokens } from "@/lib/dashboard-search";
import { getDataSource } from "@/lib/env";
import { CONTENT_FORMAT_LABEL, CONTENT_PLATFORM_LABEL, CONTENT_STATUS_META, PRODUCT_ANALYSIS_META, WORKFLOW_STATUS_META } from "@/lib/status-meta";
import type { SearchRepository } from "@/types/search";

function labels(column: SQL, entries: Record<string, string>): SQL {
  return sql`case ${column} ${sql.join(Object.entries(entries).map(([key, label]) => sql`when ${key} then ${label}`), sql` `)} else '' end`;
}

function keywordMatch(text: SQL, query: string): SQL | undefined {
  return and(...searchTokens(query).map(token => ilike(text, `%${escapeSearchLike(token)}%`)));
}

function statusLabels(meta: Record<string, { label: string }>): Record<string, string> {
  return Object.fromEntries(Object.entries(meta).map(([key, value]) => [key, value.label]));
}

export function createDbSearchRepository(): SearchRepository {
  return {
    async search(businessId, query, limit) {
      if (getDataSource() === "local") await ensureLocalDatabaseReady();
      const take = Math.min(Math.max(Math.trunc(limit), 1), 10);
      const productText = sql`concat_ws(' ', ${products.name}, ${products.description}, ${products.category}, ${products.subCategory}, ${products.origin}, ${products.specification}, ${products.tags}::text, ${labels(sql`${products.analysisStatus}`, statusLabels(PRODUCT_ANALYSIS_META))})`;
      const contentText = sql`concat_ws(' ', ${contents.title}, ${contents.hook}, ${contents.body}, ${contents.cta}, ${contents.productName}, ${products.name}, ${contents.hashtags}::text, ${labels(sql`${contents.platform}`, CONTENT_PLATFORM_LABEL)}, ${labels(sql`${contents.format}`, CONTENT_FORMAT_LABEL)}, ${labels(sql`${contents.status}`, statusLabels(CONTENT_STATUS_META))})`;
      const workflowText = sql`concat_ws(' ', ${agentWorkflows.goal}, ${labels(sql`${agentWorkflows.status}`, statusLabels(WORKFLOW_STATUS_META))})`;
      const [productRows, contentRows, workflowRows] = await Promise.all([
        getDb().select({ id: products.id, title: products.name, excerpt: sql<string>`left(concat_ws(' · ', nullif(${products.origin}, ''), nullif(${products.specification}, ''), ${products.description}), 320)`, status: products.analysisStatus })
          .from(products).where(and(eq(products.businessId, businessId), keywordMatch(productText, query)))
          .orderBy(desc(sql`lower(${products.name}) = ${query.toLocaleLowerCase()}`), desc(products.updatedAt), products.id).limit(take),
        getDb().select({ id: contents.id, title: contents.title, excerpt: sql<string>`left(concat_ws(' ', ${contents.hook}, ${contents.body}), 320)`, status: contents.status,
          productId: contents.productId, productName: products.name, platform: contents.platform, format: contents.format })
          .from(contents).innerJoin(products, eq(contents.productId, products.id))
          .where(and(eq(contents.businessId, businessId), eq(products.businessId, businessId), keywordMatch(contentText, query)))
          .orderBy(desc(sql`lower(${contents.title}) = ${query.toLocaleLowerCase()}`), desc(contents.updatedAt), contents.id).limit(take),
        getDb().select({ id: agentWorkflows.id, title: agentWorkflows.goal, excerpt: sql<string>`to_char(${agentWorkflows.createdAt} at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI')`, status: agentWorkflows.status })
          .from(agentWorkflows).where(and(eq(agentWorkflows.businessId, businessId), keywordMatch(workflowText, query)))
          .orderBy(desc(sql`lower(${agentWorkflows.goal}) = ${query.toLocaleLowerCase()}`), desc(agentWorkflows.createdAt), agentWorkflows.id).limit(take),
      ]);
      return { products: productRows, contents: contentRows, workflows: workflowRows };
    },
  };
}
