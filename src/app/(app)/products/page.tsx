import type { Metadata } from "next";
import { Boxes, Package, Sparkles, TriangleAlert, Upload } from "lucide-react";

import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { ProductGrid } from "@/components/products/product-grid";
import { Button } from "@/components/ui/button";
import { MOCK_PRODUCTS } from "@/lib/mock";

export const metadata: Metadata = {
  title: "商品中心 · 海创Buddy",
};

/** 商品中心：商品列表 + 前端筛选（Mock 数据） */
export default function ProductsPage() {
  const analyzed = MOCK_PRODUCTS.filter(
    (product) => product.analysisStatus === "analyzed",
  ).length;
  const inProgress = MOCK_PRODUCTS.filter(
    (product) =>
      product.analysisStatus === "analyzing" ||
      product.analysisStatus === "pending",
  ).length;
  const lowStock = MOCK_PRODUCTS.filter((product) => product.stock < 50).length;

  return (
    <>
      <PageHeader
        title="商品中心"
        description="管理连江海产品商品资料，并让商品经理 Agent 生成结构化 Product DNA，供其他 AI 员工共享。"
        badge={
          <span className="rounded-md bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-primary">
            Mock 数据
          </span>
        }
        actions={
          <>
            <Button variant="outline">
              <Sparkles />
              批量 AI 分析
            </Button>
            <Button>
              <Upload />
              添加商品
            </Button>
          </>
        }
      />

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="在售商品"
          value={`${MOCK_PRODUCTS.length}`}
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
          label="已生成 Product DNA"
          value={`${analyzed}`}
          unit="个"
          tone="success"
          icon={<Sparkles />}
          footer={
            <span className="text-[11px] text-muted-foreground">
              可被品牌 / 内容 / 直播 Agent 直接读取
            </span>
          }
        />
        <StatCard
          label="待分析 / 分析中"
          value={`${inProgress}`}
          unit="个"
          tone="warning"
          icon={<Boxes />}
          footer={
            <span className="text-[11px] text-muted-foreground">
              建议优先补充图片与产地资料
            </span>
          }
        />
        <StatCard
          label="库存预警"
          value={`${lowStock}`}
          unit="个"
          tone="danger"
          icon={<TriangleAlert />}
          footer={
            <span className="text-[11px] text-muted-foreground">
              含 1 个已售罄商品，需及时补货
            </span>
          }
        />
      </section>

      <ProductGrid products={MOCK_PRODUCTS} />
    </>
  );
}
