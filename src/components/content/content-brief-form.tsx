"use client";

import { LoaderCircle, Sparkles } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  CONTENT_FORMAT_LABEL,
  CONTENT_PLATFORM_LABEL,
} from "@/lib/status-meta";
import type {
  ContentBrief,
  ContentFormat,
  ContentPlatform,
  Product,
} from "@/types";

const PLATFORMS: ContentPlatform[] = [
  "douyin",
  "xiaohongshu",
  "wechat",
  "shipinhao",
  "detail",
  "ads",
];

const FORMATS: ContentFormat[] = [
  "short-video",
  "article",
  "poster-copy",
  "voiceover",
];

const GOALS = [
  "提升商品转化",
  "拉新与涨粉",
  "直播预热",
  "节庆促销",
  "品牌认知",
];

const AUDIENCES = ["年轻家庭", "品质消费者", "节庆礼赠人群", "宝妈人群", "火锅爱好者"];

const TONES = ["亲切自然", "专业讲解", "轻快活泼", "真诚实在"];

const LENGTHS = ["15 秒短视频", "30-60 秒", "1-3 分钟", "长图文"];

interface ContentBriefFormProps {
  products: Product[];
}

/**
 * 内容生成表单。
 * 本轮不接入模型：点击生成后仅给出前端反馈，说明接入点，不伪造 AI 结果。
 */
export function ContentBriefForm({ products }: ContentBriefFormProps) {
  const [brief, setBrief] = React.useState<ContentBrief>({
    productId: products[0]?.id ?? "",
    platform: "douyin",
    format: "short-video",
    goal: GOALS[0],
    audience: AUDIENCES[0],
    tone: TONES[0],
    length: LENGTHS[1],
  });
  const [generating, setGenerating] = React.useState(false);
  const [submitted, setSubmitted] = React.useState(false);

  const update = (patch: Partial<ContentBrief>) =>
    setBrief((prev) => ({ ...prev, ...patch }));

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (generating) return;
    setGenerating(true);
    window.setTimeout(() => {
      setGenerating(false);
      setSubmitted(true);
    }, 1000);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="brief-product">选择商品</Label>
          <Select
            id="brief-product"
            value={brief.productId}
            onChange={(event) => update({ productId: event.target.value })}
          >
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="brief-platform">发布平台</Label>
          <Select
            id="brief-platform"
            value={brief.platform}
            onChange={(event) =>
              update({ platform: event.target.value as ContentPlatform })
            }
          >
            {PLATFORMS.map((platform) => (
              <option key={platform} value={platform}>
                {CONTENT_PLATFORM_LABEL[platform]}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="brief-format">内容类型</Label>
          <Select
            id="brief-format"
            value={brief.format}
            onChange={(event) =>
              update({ format: event.target.value as ContentFormat })
            }
          >
            {FORMATS.map((format) => (
              <option key={format} value={format}>
                {CONTENT_FORMAT_LABEL[format]}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="brief-goal">营销目标</Label>
          <Select
            id="brief-goal"
            value={brief.goal}
            onChange={(event) => update({ goal: event.target.value })}
          >
            {GOALS.map((goal) => (
              <option key={goal} value={goal}>
                {goal}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="brief-audience">目标消费者</Label>
          <Select
            id="brief-audience"
            value={brief.audience}
            onChange={(event) => update({ audience: event.target.value })}
          >
            {AUDIENCES.map((audience) => (
              <option key={audience} value={audience}>
                {audience}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="brief-tone">内容风格</Label>
          <Select
            id="brief-tone"
            value={brief.tone}
            onChange={(event) => update({ tone: event.target.value })}
          >
            {TONES.map((tone) => (
              <option key={tone} value={tone}>
                {tone}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="brief-length">内容长度</Label>
          <Select
            id="brief-length"
            value={brief.length}
            onChange={(event) => update({ length: event.target.value })}
          >
            {LENGTHS.map((length) => (
              <option key={length} value={length}>
                {length}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex items-end">
          <Button type="submit" className="w-full" disabled={generating}>
            {generating ? (
              <>
                <LoaderCircle className="animate-spin" />
                生成中
              </>
            ) : (
              <>
                <Sparkles />
                生成内容
              </>
            )}
          </Button>
        </div>
      </div>

      <Separator />

      <p className="text-[11px] leading-5 text-muted-foreground">
        {submitted
          ? "Demo Mock：本轮未接入模型，生成逻辑将在内容运营 Agent 阶段实现；右侧列表为示例结构化输出。"
          : "内容运营 Agent 将按照 Owner Profile 的语气约束生成，输出统一为结构化 JSON（标题 / Hook / 正文 / CTA / Hashtag / 镜头建议 / 旁白）。"}
      </p>
    </form>
  );
}
