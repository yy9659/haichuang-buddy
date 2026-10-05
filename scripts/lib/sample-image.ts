/**
 * 示例商品图生成
 *
 * 目标：给 seed 出来的三款连江海产品配上「看起来像那么回事」的图片，
 * 而不是把一张纯色占位图塞进对象存储。
 * 视觉口径与前端 ProductThumb 的类目配色保持一致（海产=蓝、干货=琥珀、预制菜=青绿）。
 */

import { encodePng, type Rgb } from "./png";

export interface SampleImagePalette {
  /** 背景渐变起止色 */
  from: Rgb;
  to: Rgb;
  /** 光斑 / 气泡颜色 */
  accent: Rgb;
}

export const SAMPLE_PALETTES: Record<string, SampleImagePalette> = {
  /** 海产品：深海蓝 */
  seafood: {
    from: [214, 235, 250],
    to: [126, 178, 226],
    accent: [255, 255, 255],
  },
  /** 干货：暖琥珀 */
  dried: {
    from: [253, 240, 219],
    to: [235, 190, 128],
    accent: [255, 252, 244],
  },
  /** 预制菜：青绿 */
  prepared: {
    from: [218, 244, 236],
    to: [124, 199, 174],
    accent: [250, 255, 253],
  },
};

/** 确定性伪随机，保证每次 seed 生成的图片完全一致 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Bubble {
  x: number;
  y: number;
  radius: number;
  strength: number;
}

/**
 * 渲染一张示例商品图（默认 1200×900，4:3）：
 * 斜向渐变底 + 右上光晕 + 若干柔光气泡 + 底部压暗带（给商品名水印留位置）。
 */
export function renderSampleProductImage(options: {
  palette: SampleImagePalette;
  seed: number;
  width?: number;
  height?: number;
  bubbleCount?: number;
}): Buffer {
  const width = options.width ?? 1200;
  const height = options.height ?? 900;
  const { from, to, accent } = options.palette;
  const random = createRandom(options.seed);

  const bubbles: Bubble[] = Array.from(
    { length: options.bubbleCount ?? 14 },
    () => ({
      x: random() * width,
      y: random() * height,
      radius: (0.04 + random() * 0.12) * width,
      strength: 0.12 + random() * 0.22,
    }),
  );

  const highlightX = width * 0.78;
  const highlightY = height * 0.14;
  const highlightRadius = width * 0.55;

  return encodePng(width, height, (x, y) => {
    // 斜向渐变
    const t = (x / width) * 0.45 + (y / height) * 0.55;

    let r = from[0] + (to[0] - from[0]) * t;
    let g = from[1] + (to[1] - from[1]) * t;
    let b = from[2] + (to[2] - from[2]) * t;

    // 右上角光晕
    const haloDistance = Math.hypot(x - highlightX, y - highlightY);
    if (haloDistance < highlightRadius) {
      const halo = (1 - haloDistance / highlightRadius) ** 2 * 0.35;
      r += (accent[0] - r) * halo;
      g += (accent[1] - g) * halo;
      b += (accent[2] - b) * halo;
    }

    // 柔光气泡
    for (const bubble of bubbles) {
      const distance = Math.hypot(x - bubble.x, y - bubble.y);
      if (distance >= bubble.radius) {
        continue;
      }
      const falloff = (1 - distance / bubble.radius) ** 3;
      const mix = falloff * bubble.strength;
      r += (accent[0] - r) * mix;
      g += (accent[1] - g) * mix;
      b += (accent[2] - b) * mix;
    }

    // 底部压暗，避免右下角水印文字看不清
    const bandStart = height * 0.72;
    if (y > bandStart) {
      const depth = ((y - bandStart) / (height - bandStart)) ** 1.6 * 0.18;
      r *= 1 - depth;
      g *= 1 - depth;
      b *= 1 - depth;
    }

    return [r, g, b];
  });
}
