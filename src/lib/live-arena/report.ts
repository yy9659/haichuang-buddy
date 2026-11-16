import type { ArenaReport, ArenaState, Challenge } from "./types";

const TIPS: Record<Challenge, string> = {
  intro: "可以说：「先介绍规格，再说档案上的产地；其他细节我核对后补充。」",
  origin: "可以说：「产地和每份规格以商品档案为准；没有写明的认证，我先不作承诺。」",
  price: "可以说：「先按每份规格和每份标价比较；竞品的实际规格我没有核对，不直接判断。」",
  cold: "可以说：「我先说明已核对的配送方式；到货时间要按收货地址确认，现在不保证。」",
  storage: "可以说：「我按商品档案说明保存条件和保质期；未核实的认证不作为推荐理由。」",
  refund: "可以说：「请先保留包装和问题照片，我核对本店售后规则后说明处理方式。」",
  rush: "可以说：「我先回答库存，再回答发货；其他问题我记下逐条回复。」",
};

export const ARENA_WEIGHTS = {
  factual: { label: "商品事实准确性", weight: 25 },
  objections: { label: "异议应对能力", weight: 25 },
  selling: { label: "商品卖点覆盖率", weight: 20 },
  control: { label: "直播控场能力", weight: 20 },
  language: { label: "话术表达质量", weight: 10 },
};
const percent = (n: number, d: number) => d ? Math.round(100 * n / d) : null;

export function buildArenaReport(state: ArenaState): ArenaReport {
  const answers = state.answers;
  const risks = answers.filter((a) => a.check.risks.length > 0);
  const cited = answers.filter((a) => a.check.cited.length > 0 && !a.check.risks.length);
  const initial = state.questions.filter((q) => q.depth === 0);
  const matched = initial.map((q) => answers.find((a) => a.questionId === q.id));
  const useful = matched.reduce((n, a) => n + (a?.check.verdict === "resolved" ? 1 : a?.check.verdict === "partial" ? .5 : 0), 0);
  const coveredSelling = new Set(answers.flatMap((a) => a.check.selling)).size;
  const onTime = answers.filter((a) => a.latencyMs <= (state.config.level === "high" ? 30_000 : 50_000)).length;
  const rated = answers.filter((a) => a.check.clarity !== "unknown");
  const values = {
    factual: [percent(cited.length, cited.length + risks.length), `${cited.length} 条回答引用资料且无待核承诺，${risks.length} 条含待核承诺；无引用且无风险信号的不计。`],
    objections: [answers.length ? percent(useful, initial.length) : null, `只比较首问；完整回答计 1，部分计 0.5，未答/答非所问/待核计 0，共 ${initial.length} 道首问。`],
    selling: [answers.length ? percent(coveredSelling, state.material.sellingPoints.length) : null, `覆盖 ${coveredSelling}/${state.material.sellingPoints.length} 条经确认的 Product DNA 卖点；没有确认卖点时不评分。`],
    control: [answers.length ? percent(onTime, state.questions.length) : null, `${onTime}/${state.questions.length} 题在 ${state.config.level === "high" ? 30 : 50} 秒内提交；模型等待和暂停不计作口播时长。`],
    language: [percent(rated.filter((a) => a.check.clarity === "clear").length, rated.length), `依据 ${rated.length} 条有表达判断的转写；只评价文字，不评声音、镜头或业绩。`],
  } as const;
  const dimensions = Object.entries(ARENA_WEIGHTS).map(([key, config]) => {
    const [score, basis] = values[key as keyof typeof values];
    return { key, ...config, score, basis };
  });
  const evaluable = dimensions.filter((d) => d.score !== null);
  const weight = evaluable.reduce((n, d) => n + d.weight, 0);
  const score = weight ? Math.round(evaluable.reduce((n, d) => n + d.score! * d.weight, 0) / weight) : null;
  const weakest = [...evaluable].sort((a, b) => a.score! - b.score!)[0];
  const problem = risks[0] ?? answers.find((a) => a.check.verdict !== "resolved");
  const issue = (problem ? state.questions.find((q) => q.id === problem.questionId) : undefined)
    ?? initial.find((q) => q.status !== "resolved") ?? initial[0];
  return {
    score, dimensions, focus: issue?.challenge ?? "intro", focusQuestion: issue?.text ?? "",
    improvements: [
      weakest ? `优先练习：${weakest.label}。` : "先完成至少一轮实际应答，再查看文字评估。",
      issue ? `复练这道问题：「${issue.text}」先正面回应，再引用已核资料；没有资料时说明「我先核对，暂不承诺」。` : "先解决一个明确的观众疑问。",
      ...(issue ? [TIPS[issue.challenge]] : []),
      ...(risks.length ? ["删掉未在资料中出现的时效、认证或赔付承诺，待商户核对后再补充。"] : []),
    ],
    gaps: state.questions.filter((q) => q.depth === 0).flatMap((q) => {
      const keys = q.focus.filter((k) => !state.material.facts.some((f) => f.key === k));
      return keys.length ? [{ questionId: q.id, keys }] : [];
    }),
  };
}

export function compareArenaChallenge(before: Pick<ArenaState, "questions" | "answers" | "material">, after: Pick<ArenaState, "questions" | "answers" | "material">, challenge: Challenge) {
  const find = (s: Pick<ArenaState, "questions" | "answers">) => {
    const question = s.questions.find((q) => !q.depth && q.challenge === challenge);
    const answer = s.answers.find((a) => a.questionId === question?.id);
    return { question, answer };
  };
  return { before: find(before), after: find(after), sameFacts: before.material.version === after.material.version };
}
