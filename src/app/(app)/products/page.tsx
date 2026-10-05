import type { Metadata } from "next";
import { Boxes, Package, Sparkles, TriangleAlert } from "lucide-react";

import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { ProductCreateDialog } from "@/components/products/product-form-dialog";
import { ProductGrid } from "@/components/products/product-grid";
import { Badge } from "@/components/ui/badge";
import { unwrapOrThrow } from "@/lib/result";
import type { RawSearchParams } from "@/lib/search-params";
import { DATA_SOURCE_LABEL } from "@/lib/status-meta";
import { getProductsView } from "@/services";

export const metadata: Metadata = {
  title: "商品中心 · 海创Buddy",
};

interface ProductsPageProps {
  /** 筛选与分页都由 URL 承载，因此本页按请求渲染 */
  searchParams: Promise<RawSearchParams>;
}

/** 商品中心：真实 CRUD + 服务端筛选分页 */
export default async function ProductsPage({ searchParams }: ProductsPageProps) {
  const view = unwrapOrThrow(await getProductsView(await searchParams));
  const { products, summary, pagination, query, imageUploadEnabled } = view;

  return (
    <>
      <PageHeader
        title="商品中心"
        description="集中管理商品资料、卖点与库存。"
        badge={
          <Badge variant="soft">{DATA_SOURCE_LABEL[view.dataSource]}</Badge>
        }
        actions={<ProductCreateDialog imageUploadEnabled={imageUploadEnabled} />}
      />

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="在售商品"
          value={`${summary.total}`}
          unit="个"
          tone="primary"
          icon={<Package />}
          footer={
            <span className="text-[11px] text-muted-foreground">
              覆盖海产、干货与礼盒三大类
            </span>
          }
        />
        <StatCard
          label="资料已完善"
          value={`${summary.analyzed}`}
          unit="个"
          tone="success"
          icon={<Sparkles />}
        />
        <StatCard
          label="待分析 / 分析中"
          value={`${summary.inProgress}`}
          unit="个"
          tone="warning"
          icon={<Boxes />}
        />
        <StatCard
          label="库存预警"
          value={`${summary.lowStock}`}
          unit="个"
          tone="danger"
          icon={<TriangleAlert />}
          footer={
            <span className="text-[11px] text-muted-foreground">
              含 {summary.soldOut} 个已售罄商品，需及时补货
            </span>
          }
        />
      </section>

      <ProductGrid
        products={products}
        pagination={pagination}
        query={query}
        totalCount={summary.total}
        imageUploadEnabled={imageUploadEnabled}
      />
    </>
  );
}
