/**
 * Seed Knowledge Contract Test（Task 81 §21）
 *
 * 锁死「种子知识库不得包含具体物流时效承诺」这条最小契约。
 *
 * 任务书 §20 要求 DB Seed 至少包含五份知识（鲍鱼储存 / 鱼丸烹饪 /
 * 海带储存 / 售后规则 / FAQ），但**故意不含「多久发货」的物流时效答案**
 * —— 演示闭环要靠商家在缺口出现时**手动补知识**走通。Task 77 已经踩过坑：
 * 种子声明「不含发货时效」，正文里却偷写「12 小时发货」，最后演示时 AI
 * 跳过了缺口环节直接给出答案。
 *
 * 这个测试的存在就是为了防止再次出现同样的倒退：任何人增改种子知识，
 * 如果引入了具体时效承诺，CI 会立刻失败，并指出在哪一条哪个词。
 *
 * **注意**：仅禁止「**发货 / 送达时效**」承诺，不禁止「签收后检查时效」、
 * 「报备时效」这种与发货无关的售后条款。Task 77 的种子《鲜活类商品赔付规则》
 * 里「签收后 24 小时内检查」是合法的，不算违约。
 */
import { describe, expect, it } from "vitest";

import { MOCK_KNOWLEDGE_DOCUMENTS } from "@/lib/mock";

/**
 * 形如「N 小时内发货」「次日发货」「当天发货」的强承诺。
 * 不命中「签收后 N 小时内检查」「签收后 N 小时报备」这类售后时效。
 */
const FORBIDDEN_DELIVERY_PATTERNS: RegExp[] = [
  // 「X 小时内发货」「X 小时发货」
  /\d+\s*小时(?:内)?\s*发(?:货|送)/,
  // 「X 小时送达」「X 小时内送达」
  /\d+\s*小时(?:内)?\s*送达/,
  // 单字「当天发货」「当日发货」「次日发货」「次日送达」「次日达」
  /(?:当天|当日|次日)(?:发货|送达|达)/,
];

describe("Seed Knowledge Contract（§21）", () => {
  it("每份种子都有可识别的 name / type / content", () => {
    for (const seed of MOCK_KNOWLEDGE_DOCUMENTS) {
      expect(seed.name.trim().length).toBeGreaterThan(0);
      expect(seed.content.trim().length).toBeGreaterThan(0);
      expect(typeof seed.type).toBe("string");
    }
  });

  it("种子知识不含具体发货时效承诺（演示闭环刻意保留「多久发货」缺口）", () => {
    const violations: string[] = [];
    for (const seed of MOCK_KNOWLEDGE_DOCUMENTS) {
      const haystack = `${seed.name}\n${seed.summary ?? ""}\n${seed.content}`;
      for (const pattern of FORBIDDEN_DELIVERY_PATTERNS) {
        const match = haystack.match(pattern);
        if (match) {
          violations.push(`《${seed.name}》→ 「${match[0]}」`);
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        "种子知识出现具体发货时效承诺：\n" +
          violations.map((v) => `  - ${v}`).join("\n") +
          "\n这会让演示时 AI 直接给出物流时效，破坏 Task 80/81 的「补知识 → 解决」闭环。\n" +
          "种子知识只能用「采用冷链配送」这类不构成时效答案的事实表述。",
      );
    }
    expect(violations).toHaveLength(0);
  });
});