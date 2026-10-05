/** 直播彩排的可选 AI 出题、口播文字与文字依据复盘。 */
import { z } from "zod";

import { getAIProvider } from "@/ai/provider";
import type { AIProvider } from "@/ai/provider/types";
import { generateValidatedObject } from "@/ai/schemas/agent-output";
import { attempt, fail, toAppError, type Result } from "@/lib/result";
import { getRepositories } from "@/repositories";
import {
  AI_REHEARSAL_AUTHOR, MAX_HOST_TRANSCRIPT_LENGTH, MAX_REHEARSAL_QUESTIONS,
  type LiveRehearsalReport, type LiveSession,
} from "@/types";

import { submitLiveComment, type SubmitLiveCommentResult } from "./live-agent.service";

const questionSchema = z.object({ question: z.string().trim().min(5).max(120) });
const reportDraftSchema = z.object({
  score: z.number().int().min(0).max(100),
  summary: z.string().trim().min(8).max(300),
  strengths: z.array(z.string().trim().min(2).max(120)).max(3),
  improvements: z.array(z.string().trim().min(2).max(120)).min(1).max(3),
  nextPractice: z.string().trim().min(5).max(180),
});

async function currentSession(sessionId: string): Promise<Result<LiveSession>> {
  const loaded = await attempt(() => getRepositories().live.getSession(),
    (cause) => toAppError(cause, "DB_ERROR", "读取彩排场次失败"));
  if (!loaded.ok) return loaded;
  if (!loaded.data || loaded.data.id !== sessionId) return fail("NOT_FOUND", "彩排场次不存在");
  return { ok: true, data: loaded.data };
}

function providerOrError(override?: AIProvider): Result<AIProvider> {
  try {
    return { ok: true, data: override ?? getAIProvider() };
  } catch (cause) {
    return { ok: false, error: toAppError(cause, "MODEL_UNAVAILABLE", "AI 服务暂不可用") };
  }
}

export async function generateRehearsalQuestion(
  sessionId: string,
  options: { provider?: AIProvider } = {},
): Promise<Result<SubmitLiveCommentResult>> {
  const session = await currentSession(sessionId);
  if (!session.ok) return session;
  if (session.data.status !== "live") return fail("VALIDATION_FAILED", "请先开始彩排，再开启 AI 出题");

  const repositories = getRepositories();
  const loaded = await attempt(async () => Promise.all([
    repositories.products.getById(session.data.productId),
    repositories.live.listComments(sessionId),
  ]), (cause) => toAppError(cause, "DB_ERROR", "读取出题依据失败"));
  if (!loaded.ok) return loaded;
  const [product, comments] = loaded.data;
  if (!product) return fail("NOT_FOUND", "彩排商品已不存在");
  const generatedQuestions = comments.filter((item) => item.authorName === AI_REHEARSAL_AUTHOR);
  if (generatedQuestions.length >= MAX_REHEARSAL_QUESTIONS) {
    return fail("VALIDATION_FAILED", `本场最多生成 ${MAX_REHEARSAL_QUESTIONS} 个 AI 模拟问题`);
  }

  const provider = providerOrError(options.provider);
  if (!provider.ok) return provider;
  let question: string;
  if (provider.data.id === "mock") {
    const examples = [
      `这款${product.name}适合什么场景？`,
      `这款${product.name}应该怎么保存？`,
      `这款${product.name}的规格和价格怎么理解？`,
      `如果收到${product.name}后有问题，应该怎么办？`,
      `这款${product.name}和同类商品有什么区别？`,
    ];
    question = examples[generatedQuestions.length] ?? examples[0];
  } else {
    const generated = await generateValidatedObject({
      provider: provider.data,
      schema: questionSchema,
      system: "你是直播彩排中的模拟顾客。只提出一个简短、自然、可回答的问题；不要编造商品事实、价格优惠或商家承诺。只输出 JSON：{\"question\":\"...\"}。",
      prompt: JSON.stringify({
        product: { name: product.name, description: product.description, price: product.price,
          unit: product.unit, storageMethod: product.storageMethod, shelfLife: product.shelfLife },
        previousQuestions: comments.slice(-8).map((item) => item.content),
        instruction: "换一个尚未问过的角度，像真实顾客发问。",
      }),
      tier: "fast",
    });
    if (!generated.ok) return generated;
    question = generated.data.value.question;
  }
  return submitLiveComment({ sessionId, content: question, authorName: AI_REHEARSAL_AUTHOR },
    { provider: provider.data });
}

export async function saveHostTranscript(sessionId: string, text: string): Promise<Result<LiveSession>> {
  const transcript = text.trim();
  if (transcript.length > MAX_HOST_TRANSCRIPT_LENGTH) {
    return fail("VALIDATION_FAILED", `口播记录最多 ${MAX_HOST_TRANSCRIPT_LENGTH} 字`);
  }
  const session = await currentSession(sessionId);
  if (!session.ok) return session;
  if (session.data.hostTranscript === transcript) return session;
  return attempt(() => getRepositories().live.updateSession(sessionId, {
    hostTranscript: transcript,
    rehearsalReport: null,
  }), (cause) => toAppError(cause, "DB_ERROR", "保存口播记录失败"));
}

export async function scoreLiveRehearsal(
  sessionId: string,
  options: { provider?: AIProvider } = {},
): Promise<Result<LiveRehearsalReport>> {
  const session = await currentSession(sessionId);
  if (!session.ok) return session;
  if (session.data.status !== "ended") return fail("VALIDATION_FAILED", "请先结束彩排再评分");
  const transcript = session.data.hostTranscript?.trim() ?? "";
  if (transcript.length < 10) return fail("VALIDATION_FAILED", "请先录入或语音转写至少 10 字口播内容，再评分");

  const loaded = await attempt(async () => Promise.all([
    getRepositories().live.listComments(sessionId),
    getRepositories().live.listSuggestions(sessionId),
  ]), (cause) => toAppError(cause, "DB_ERROR", "读取本场彩排记录失败"));
  if (!loaded.ok) return loaded;
  const [comments, suggestions] = loaded.data;
  if (comments.length === 0) return fail("VALIDATION_FAILED", "本场还没有模拟问题，无法评估应答；请先完成至少一轮问答");
  const provider = providerOrError(options.provider);
  if (!provider.ok) return provider;

  let draft: z.infer<typeof reportDraftSchema>;
  if (provider.data.id === "mock") {
    draft = {
      score: Math.min(85, 55 + Math.min(20, Math.floor(transcript.length / 40)) + Math.min(10, comments.length * 2)),
      summary: "演示评分仅展示流程；请接入真实模型后再用于复盘判断。",
      strengths: ["已留下可复盘的口播文字"],
      improvements: ["逐条核对顾客问题是否得到直接回答", "核实口播中的商品事实与承诺"],
      nextPractice: "围绕本场最难回答的问题，再练习一段简短、准确的回应。",
    };
  } else {
    const generated = await generateValidatedObject({
      provider: provider.data,
      schema: reportDraftSchema,
      system: "你是严格的直播彩排教练。仅根据文字记录评价主播应答覆盖、表达清晰度和事实风险。不能假装看过视频、听过音色，也不能把 AI 导演建议当成主播已经说过的话。评分 0-100，解释必须与文字对应。只输出 JSON 字段 score, summary, strengths, improvements, nextPractice。",
      prompt: JSON.stringify({
        product: session.data.productName,
        questions: comments.slice(0, 12).map((item) => item.content),
        referenceSuggestions: suggestions.slice(0, 12).filter((item) => !item.failureMessage)
          .map((item) => ({ question: item.commentContent, suggestion: item.hostSuggestion, risks: item.riskNotes })),
        hostTranscript: transcript,
        instruction: "若口播未覆盖问题或有无法核实的承诺，应明确扣分并给可执行的练习建议。",
      }),
      tier: "reasoning",
    });
    if (!generated.ok) return generated;
    draft = generated.data.value;
  }

  const report: LiveRehearsalReport = {
    ...draft, basis: "text_only", generatedAt: new Date().toISOString(),
    providerId: provider.data.id, isMock: provider.data.id === "mock",
  };
  const saved = await attempt(() => getRepositories().live.updateSession(sessionId, { rehearsalReport: report }),
    (cause) => toAppError(cause, "DB_ERROR", "保存彩排评分失败"));
  if (!saved.ok) return saved;
  return { ok: true, data: report };
}
