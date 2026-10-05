import { z } from "zod";
import type { SalesReviewSnapshot } from "@/types";

/** 建议只能引用本次销售依据，金额和百分比不能由模型凭空补充。 */
export function createSalesReviewSchema(snapshot: SalesReviewSnapshot) {
  const ids = new Set(snapshot.facts.map(fact => fact.id));
  const evidenceIds = z.array(z.string().refine(id => ids.has(id), "只能引用本次销售依据的 id")).min(1).max(3);
  const insight = z.object({ title: z.string().trim().min(1).max(50), explanation: z.string().trim().min(1).max(220), evidenceIds });
  return z.object({
    summary: z.string().trim().min(1).max(320),
    opportunities: z.array(insight).min(1).max(3),
    watchouts: z.array(insight).max(3),
    actions: z.array(insight.extend({
      priority: z.number().int().min(1).max(3),
      steps: z.string().trim().min(1).max(240),
      destination: z.enum(["sales", "content", "products", "customer_service"]),
      productName: z.string().nullable().refine(name => name === null || snapshot.products.some(product => product.name === name), "商品名称须来自本次销售商品清单"),
    })).min(1).max(3),
  }).superRefine((review, ctx) => {
    if (new Set(review.actions.map(action => action.priority)).size !== review.actions.length) ctx.addIssue({ code: "custom", path: ["actions"], message: "行动优先级不能重复" });
    const facts = snapshot.facts.map(fact => fact.display).join(" ").replace(/,/g, "");
    const allowedMoney = new Set([...facts.matchAll(/¥(-?\d+(?:\.\d+)?)/g)].map(match => Number(match[1])));
    const allowedPercents = new Set([...facts.matchAll(/(-?\d+(?:\.\d+)?)%/g)].map(match => Number(match[1])));
    const names = snapshot.products.map(product => product.name);
    const texts = [review.summary, ...review.opportunities.flatMap(item => [item.title, item.explanation]), ...review.watchouts.flatMap(item => [item.title, item.explanation]), ...review.actions.flatMap(item => [item.title, item.explanation, item.steps])];
    for (let text of texts) {
      for (const name of names) text = text.replaceAll(name, "商品");
      for (const match of text.replace(/,/g, "").matchAll(/(?:[¥￥]\s*-?\d+(?:\.\d+)?|-?\d+(?:\.\d+)?\s*(?:元|%|％))/g)) {
        const normalized = match[0].replace(/\s/g, "").replace("￥", "¥").replace("％", "%");
        const amount = normalized.replace(/^[¥]/, "").replace(/(?:元|%)$/, "");
        const supported = normalized.endsWith("%") ? allowedPercents.has(Number(amount)) : allowedMoney.has(Number(amount));
        if (!supported) ctx.addIssue({ code: "custom", message: `金额或百分比「${match[0]}」没有销售依据，请引用原值或改用文字建议` });
      }
      if (/(?:订单(?:量|数)?|复购率|转化率|客单价|播放量|曝光量)[^。；\n]{0,10}\d|\d+\s*(?:个|笔|单)?\s*订单/.test(text)) ctx.addIssue({ code: "custom", message: "销售明细不能推导订单量、复购、转化、播放或曝光数据" });
    }
    if (snapshot.summary.grossProfitCents === null && review.actions.some(action => /毛利率.{0,8}\d/.test(action.explanation))) ctx.addIssue({ code: "custom", message: "成本未补齐，不能给出整批毛利率" });
  });
}
