import type { PublicKnowledgeDocument } from "@/types/admin";

export const PUBLIC_KNOWLEDGE_SEEDS: PublicKnowledgeDocument[] = [
  {
    id: "80000000-0000-4000-8000-000000000001", title: "连江鲍鱼地理标志标准", category: "产地与地标",
    content: "标准索引：DB35/T 1449-2014《地理标志产品 连江鲍鱼》。\n\n适用范围涉及保护范围、养殖与加工、质量检验，以及标志、包装、运输与贮存。具体指标和适用条件请查阅标准原文。\n\n本条为公开标准目录摘要，不是检测结论，也不证明某件商品已经获得地理标志使用授权。",
    tags: ["连江鲍鱼", "地理标志", "标准索引"], sourceName: "全国标准信息公共服务平台",
    sourceUrl: "https://std.samr.gov.cn/db/search/stdDBDetailed?id=91D99E4D36682E24E05397BE0A0A3A10",
    status: "published", verified: true, updatedBy: "公开资料初始化", createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z",
  },
  {
    id: "80000000-0000-4000-8000-000000000002", title: "连江手工鱼丸含鱼量品质规范", category: "品质规范",
    content: "待核验资料草稿。\n\n录入时请补充：适用产品、规范发布主体、文件编号与版本、配料标示要求、含鱼量的计算或检测依据、核验凭证。\n\n当前未录入含鱼量数值，不可据此宣称商品达到某个品质等级。请取得正式文件或商户核实资料后完善正文。",
    tags: ["手工鱼丸", "配料", "待核验"], sourceName: "运营资料草稿", sourceUrl: "", status: "draft", verified: false,
    updatedBy: "演示资料初始化", createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z",
  },
  {
    id: "80000000-0000-4000-8000-000000000003", title: "冷链运输包赔标准", category: "冷链与售后",
    content: "待核验的售后规则草稿。\n\n请按实际物流合同和店铺承诺填写：适用品类、配送范围、运输与包装条件、异常签收取证、申请入口、赔付范围及处理时限。\n\n不同商户与物流服务的规则可能不同；本条尚未构成统一赔付承诺，发布前须由责任方确认。",
    tags: ["冷链运输", "售后", "待核验"], sourceName: "运营资料草稿", sourceUrl: "", status: "draft", verified: false,
    updatedBy: "演示资料初始化", createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z",
  },
];
