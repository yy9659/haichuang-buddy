import type { ProductPosterSource } from "@/types";
import { POSTER_SIZES, wrapPosterText, posterPrice, type PosterCopy, type PosterSize, type PosterTemplate } from "./product-poster";
import { mixPosterColor, readablePosterInk, type PosterDesign } from "./poster-design";

const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';

const PALETTES = {
  fresh: { background: ["#f4faf6", "#e2f2ed"], ink: "#193d40", muted: "#587575", accent: "#0b8087", soft: "#d2ebe5", card: "#ffffff", priceCard: "#173f43", priceInk: "#ffffff", priceMuted: "#b9dad7", photo: "#dfede8", wave: "#0b8087" },
  warm: { background: ["#fff9ee", "#f4e5cf"], ink: "#513727", muted: "#8a705d", accent: "#b94e2d", soft: "#efd7bf", card: "#fffaf2", priceCard: "#643c2a", priceInk: "#fff8ed", priceMuted: "#e9cbb3", photo: "#eee0ca", wave: "#b94e2d" },
  ocean: { background: ["#153e56", "#081d2e"], ink: "#f3fbfc", muted: "#a6c6d3", accent: "#56d6e5", soft: "#20485d", card: "#16394e", priceCard: "#e3f5f5", priceInk: "#103a44", priceMuted: "#4b7278", photo: "#183c51", wave: "#56d6e5" },
} satisfies Record<PosterTemplate, {
  background: string[]; ink: string; muted: string; accent: string; soft: string;
  card: string; priceCard: string; priceInk: string; priceMuted: string; photo: string; wave: string;
}>;

/** 使用真实商品图，不调用模型画商品；远程图片须允许跨域读取。 */
export function loadPosterPhoto(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const resolved = new URL(url, window.location.href);
    if (!(["http:", "https:"].includes(resolved.protocol) || /^data:image\/(?:png|jpeg|webp|avif);base64,/i.test(url))) {
      reject(new Error("商品照片格式不支持，请上传 JPG、PNG 或 WebP 图片。"));
      return;
    }
    if (resolved.origin !== window.location.origin && resolved.protocol !== "data:") image.crossOrigin = "anonymous";
    image.decoding = "async";
    const timeout = window.setTimeout(() => finish(new Error("商品照片读取超时，请重试。")), 15_000);
    function finish(error?: Error): void {
      window.clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      if (error) reject(error);
      else if (!image.naturalWidth || !image.naturalHeight) reject(new Error("商品照片为空，请重新上传。"));
      else resolve(image);
    }
    image.onload = () => finish();
    image.onerror = () => finish(new Error("商品照片无法读取，请重试，或到商品中心重新上传照片。"));
    image.src = url;
  });
}

function roundedBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number, fill: string | CanvasGradient): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fillStyle = fill;
  ctx.fill();
}

function outlineBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number, color: string, lineWidth = 1): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

function fitText(ctx: CanvasRenderingContext2D, text: string, width: number, maxLines: number, initialSize: number, minSize: number, weight = 600, maxHeight = Infinity, font = FONT): { lines: string[]; size: number } {
  for (let size = initialSize; size >= minSize; size -= 2) {
    ctx.font = `${weight} ${size}px ${font}`;
    const lines = wrapPosterText(text, width, (value) => ctx.measureText(value).width);
    if (lines.length <= maxLines && lines.length * size * 1.25 <= maxHeight) return { lines, size };
  }
  throw new Error("海报文字较长，请缩短标题、副标题、卖点或引导语后重试。");
}

function textBlock(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, maxLines: number, initialSize: number, minSize: number, color: string, weight = 600, maxHeight = Infinity, font = FONT, align: "left" | "center" = "left"): number {
  const fit = fitText(ctx, text, width, maxLines, initialSize, minSize, weight, maxHeight, font);
  ctx.fillStyle = color;
  fit.lines.forEach((line, index) => ctx.fillText(line, x + (align === "center" ? (width - ctx.measureText(line).width) / 2 : 0), y + index * fit.size * 1.25));
  return y + fit.lines.length * fit.size * 1.25;
}

function renderComposedPoster(ctx: CanvasRenderingContext2D, photo: HTMLImageElement, product: ProductPosterSource, copy: PosterCopy, design: PosterDesign, width: number, height: number, isDemo: boolean, atmosphere?: HTMLImageElement): void {
  const plan = design.composition!;
  const ink = readablePosterInk(design.palette.background, design.palette.foreground);
  const accent = readablePosterInk(design.palette.background, design.palette.accent);
  const muted = mixPosterColor(ink, design.palette.background, 0.23);
  const ornamented = design.decoration !== "minimal";
  const region = (key: "title" | "subtitle" | "photo" | "sellingPoints" | "price" | "cta") => {
    const box = plan[key];
    return { x: box.x * width / 1000, y: box.y * height / 1000, w: box.width * width / 1000, h: box.height * height / 1000 };
  };
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, mixPosterColor(design.palette.background, design.palette.surface, 0.28));
  gradient.addColorStop(0.5, design.palette.background);
  gradient.addColorStop(1, mixPosterColor(design.palette.background, design.palette.accent, ornamented ? 0.18 : 0.06));
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
  if (atmosphere) {
    const scale = Math.max(width / atmosphere.naturalWidth, height / atmosphere.naturalHeight);
    ctx.save(); ctx.globalAlpha = 0.18; ctx.filter = "blur(24px)";
    ctx.drawImage(atmosphere, (width - atmosphere.naturalWidth * scale) / 2, (height - atmosphere.naturalHeight * scale) / 2, atmosphere.naturalWidth * scale, atmosphere.naturalHeight * scale);
    ctx.restore();
  }
  if (ornamented) {
    const image = region("photo"), price = region("price"), action = region("cta");
    const field = ctx.createLinearGradient(0, image.y, width, image.y + image.h);
    field.addColorStop(0, mixPosterColor(design.palette.background, design.palette.accent, 0.16));
    field.addColorStop(1, mixPosterColor(design.palette.background, design.palette.surface, 0.64));
    roundedBox(ctx, 22, Math.max(24, image.y - 18), width - 44, Math.min(height - image.y - 48, image.h + 36), 44, field);
    const offerY = Math.max(24, Math.min(price.y, action.y) - 18);
    const offerBottom = Math.min(height - 42, Math.max(price.y + price.h, action.y + action.h) + 18);
    roundedBox(ctx, 22, offerY, width - 44, offerBottom - offerY, 32, mixPosterColor(design.palette.background, design.palette.surface, 0.6));

    ctx.save();
    ctx.fillStyle = design.palette.accent; ctx.globalAlpha = 0.12;
    ctx.beginPath(); ctx.arc(width + 12, -16, width * 0.32, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.07;
    ctx.beginPath(); ctx.arc(-20, height * 0.88, width * 0.28, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = design.palette.accent; ctx.globalAlpha = 0.27; ctx.lineWidth = 2;
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      if (design.decoration === "circles") ctx.arc(width + 12, -16, width * (0.2 + i * 0.042), 0, Math.PI * 2);
      else { ctx.moveTo(width * 0.65, -18 + i * 22); ctx.bezierCurveTo(width * 0.85, height * 0.1, width * 1.08, height * 0.04, width + 20, height * 0.28 + i * 26); }
      ctx.stroke();
    }
    ctx.restore();
    outlineBox(ctx, 18, 18, width - 36, height - 36, 28, mixPosterColor(design.palette.background, design.palette.accent, 0.36), 2);
    outlineBox(ctx, 28, 28, width - 56, height - 56, 20, mixPosterColor(design.palette.background, design.palette.accent, 0.14));
  }
  const image = region("photo");
  const framed = plan.photoFrame !== "none";
  const framePad = framed ? 24 : 0;
  const frameRadius = plan.photoFrame === "paper" ? 8 : 30;
  if (plan.photoFrame !== "none") {
    ctx.save(); ctx.shadowColor = "rgba(8,25,39,0.24)"; ctx.shadowBlur = 38; ctx.shadowOffsetY = 16;
    const matte = ctx.createLinearGradient(image.x, image.y, image.x + image.w, image.y + image.h);
    matte.addColorStop(0, design.palette.surface);
    matte.addColorStop(1, mixPosterColor(design.palette.surface, design.palette.accent, 0.2));
    roundedBox(ctx, image.x, image.y, image.w, image.h, frameRadius, matte);
    ctx.restore();
    outlineBox(ctx, image.x + 7, image.y + 7, image.w - 14, image.h - 14, Math.max(3, frameRadius - 7), mixPosterColor(design.palette.surface, design.palette.accent, 0.42), 2);
    // 同一实拍的柔焦底层填充相框，前景完整保留商品原图。
    ctx.save();
    ctx.beginPath(); ctx.roundRect(image.x + framePad, image.y + framePad, image.w - framePad * 2, image.h - framePad * 2, 10); ctx.clip();
    const cover = Math.max(image.w / photo.naturalWidth, image.h / photo.naturalHeight);
    ctx.globalAlpha = 0.2; ctx.filter = "blur(28px)";
    ctx.drawImage(photo, image.x + (image.w - photo.naturalWidth * cover) / 2, image.y + (image.h - photo.naturalHeight * cover) / 2, photo.naturalWidth * cover, photo.naturalHeight * cover);
    ctx.restore();
  }
  const imageScale = Math.min((image.w - framePad * 2) / photo.naturalWidth, (image.h - framePad * 2) / photo.naturalHeight) * design.photoScale;
  const photoWidth = photo.naturalWidth * imageScale, photoHeight = photo.naturalHeight * imageScale;
  ctx.drawImage(photo, image.x + (image.w - photoWidth) / 2, image.y + (image.h - photoHeight) / 2, photoWidth, photoHeight);

  ctx.textBaseline = "top";
  const headlineFont = design.typography === "elegant" ? '"STSong", "SimSun", "Songti SC", serif' : FONT;
  const textRegion = (key: "title" | "subtitle" | "cta", text: string, initial: number, minimum: number, color: string, weight: number, font = FONT) => {
    const box = region(key);
    if (atmosphere) roundedBox(ctx, box.x - 4, box.y - 4, box.w + 8, box.h + 8, 8, design.palette.background);
    const decorated = ornamented && key !== "subtitle";
    let padX = decorated ? 16 : 0, padY = decorated ? 6 : 0;
    if (decorated) {
      const fill = mixPosterColor(design.palette.background, design.palette.accent, key === "title" ? 0.08 : 0.16);
      roundedBox(ctx, box.x, box.y, box.w, box.h, key === "title" ? 18 : 22, fill);
      if (key === "cta") outlineBox(ctx, box.x + 1, box.y + 1, box.w - 2, box.h - 2, 21, mixPosterColor(design.palette.background, design.palette.accent, 0.44), 2);
      else { ctx.fillStyle = design.palette.accent; ctx.fillRect(box.x + 2, box.y + 12, 4, Math.min(48, box.h - 24)); }
    }
    let fit: ReturnType<typeof fitText>;
    try {
      fit = fitText(ctx, text, box.w - padX * 2, key === "title" ? 6 : 10, initial, minimum, weight, box.h - padY * 2 - 4, font);
    } catch (cause) {
      if (!decorated) throw cause;
      // 长文案优先缩小内边距，保留全部文字和可读字号。
      padX = 6; padY = 2;
      fit = fitText(ctx, text, box.w - padX * 2, 10, initial, minimum, weight, box.h - padY * 2 - 4, font);
    }
    const blockHeight = fit.lines.length * fit.size * 1.25;
    return textBlock(ctx, text, box.x + padX, box.y + (decorated || key === "cta" ? (box.h - blockHeight) / 2 : 0), box.w - padX * 2, 10, fit.size, minimum, color, weight, box.h - padY * 2, font, key === "title" ? design.titleAlign : "left");
  };
  textRegion("title", copy.title, plan.headlineSize, 26, ink, design.typography === "clean" ? 600 : 800, headlineFont);
  if (design.showSubtitle) textRegion("subtitle", copy.subtitle, 32, 18, muted, 500);
  if (design.showSellingPoints) {
    const box = region("sellingPoints");
    if (atmosphere) roundedBox(ctx, box.x - 4, box.y - 4, box.w + 8, box.h + 8, 8, design.palette.background);
    if (plan.sellingPointStyle === "inline") {
      const padding = ornamented ? 14 : 0;
      if (ornamented) {
        roundedBox(ctx, box.x, box.y, box.w, box.h, 18, mixPosterColor(design.palette.background, design.palette.accent, 0.13));
        outlineBox(ctx, box.x + 1, box.y + 1, box.w - 2, box.h - 2, 17, mixPosterColor(design.palette.background, design.palette.accent, 0.3));
      }
      const text = copy.sellingPoints.join("  ·  ");
      const fit = fitText(ctx, text, box.w - padding * 2, 8, 30, 16, 600, box.h - 12);
      textBlock(ctx, text, box.x + padding, box.y + (box.h - fit.lines.length * fit.size * 1.25) / 2, box.w - padding * 2, 8, fit.size, 16, accent, 600, box.h - 12);
    } else {
      const gap = 10, rowHeight = (box.h - gap * (copy.sellingPoints.length - 1)) / copy.sellingPoints.length;
      copy.sellingPoints.forEach((point, index) => {
        const y = box.y + index * (rowHeight + gap), cards = plan.sellingPointStyle === "cards";
        if (cards) {
          roundedBox(ctx, box.x, y, box.w, rowHeight, 14, mixPosterColor(design.palette.background, design.palette.accent, 0.13));
          outlineBox(ctx, box.x + 1, y + 1, box.w - 2, rowHeight - 2, 13, mixPosterColor(design.palette.background, design.palette.accent, 0.3));
        }
        ctx.fillStyle = accent; ctx.fillRect(box.x + (cards ? 12 : 0), y + 6, 3, Math.min(22, rowHeight - 10));
        textBlock(ctx, point, box.x + (cards ? 25 : 16), y + (cards ? 6 : 0), box.w - (cards ? 36 : 16), 8, 28, 16, muted, 500, rowHeight - (cards ? 12 : 0));
      });
    }
  }
  const price = region("price"), ticket = plan.priceStyle === "ticket";
  if (ticket) {
    const priceFill = ctx.createLinearGradient(price.x, price.y, price.x + price.w, price.y + price.h);
    priceFill.addColorStop(0, design.palette.accent);
    priceFill.addColorStop(1, mixPosterColor(design.palette.accent, ink, 0.12));
    ctx.save(); ctx.shadowColor = "rgba(8,25,39,0.18)"; ctx.shadowBlur = 20; ctx.shadowOffsetY = 8;
    roundedBox(ctx, price.x, price.y, price.w, price.h, 22, priceFill);
    ctx.restore();
    outlineBox(ctx, price.x + 6, price.y + 6, price.w - 12, price.h - 12, 16, mixPosterColor(design.palette.accent, design.palette.background, 0.38));
  }
  else if (atmosphere) roundedBox(ctx, price.x - 4, price.y - 4, price.w + 8, price.h + 8, 8, design.palette.background);
  const priceInk = ticket ? readablePosterInk(design.palette.accent, design.palette.background) : plan.priceStyle === "accent" ? accent : ink;
  const inset = ticket ? 20 : 0, amountY = ticket ? 38 : 28;
  ctx.fillStyle = priceInk; ctx.font = `500 18px ${FONT}`; ctx.fillText("商品售价", price.x + inset, price.y + (ticket ? 12 : 2));
  const amount = `¥${posterPrice(product.price)} / ${product.unit}`;
  textBlock(ctx, amount, price.x + inset, price.y + amountY, price.w - inset * 2, 3, design.emphasis === "price" ? 88 : 64, 18, priceInk, 800, price.h - amountY - (ticket ? 10 : 2));
  const action = region("cta");
  const actionBottom = textRegion("cta", copy.cta, 30, 16, accent, 600);
  if (!ornamented) { ctx.fillStyle = design.palette.accent; ctx.fillRect(action.x, Math.min(actionBottom + 6, action.y + action.h - 2), Math.min(72, action.w), 2); }
  ctx.font = `400 17px ${FONT}`;
  const footer = atmosphere ? "海创Buddy · 商品实拍与创意背景" : "海创Buddy · 商品实拍";
  if (ornamented) roundedBox(ctx, width * 0.054 - 7, height - 29, ctx.measureText(footer).width + 14, 25, 4, mixPosterColor(design.palette.background, design.palette.accent, 0.17));
  ctx.fillStyle = muted; ctx.fillText(footer, width * 0.054, height - 26);
  if (isDemo) {
    ctx.font = `600 18px ${FONT}`;
    if (ornamented) roundedBox(ctx, width - 143, height - 29, ctx.measureText("演示素材").width + 14, 25, 4, mixPosterColor(design.palette.background, design.palette.accent, 0.17));
    ctx.fillStyle = accent; ctx.fillText("演示素材", width - 136, height - 26);
  }
}

/** 预览与 PNG 导出共用这张画布，价格始终使用商品档案字段。 */
export function renderProductPoster(canvas: HTMLCanvasElement, photo: HTMLImageElement, product: ProductPosterSource, copy: PosterCopy, size: PosterSize, isDemo: boolean, template: PosterTemplate = "fresh", options: { design?: PosterDesign; background?: HTMLImageElement } = {}): void {
  const { width, height } = POSTER_SIZES[size];
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("当前浏览器不支持海报预览，请使用最新版浏览器。");
  const portrait = size === "portrait";
  const design = options.design;
  if (design?.composition) {
    renderComposedPoster(ctx, photo, product, copy, design, width, height, isDemo, options.background);
    ctx.getImageData(0, 0, 1, 1);
    return;
  }
  const ink = design ? readablePosterInk(design.palette.background, design.palette.foreground) : PALETTES[template].ink;
  const palette = design ? {
    background: [design.palette.background, mixPosterColor(design.palette.background, design.palette.accent, 0.1)],
    ink, muted: mixPosterColor(ink, design.palette.background, 0.25), accent: design.palette.accent,
    soft: mixPosterColor(design.palette.background, design.palette.accent, 0.16), card: design.palette.surface,
    priceCard: mixPosterColor(design.palette.background, ink, 0.88), priceInk: readablePosterInk(mixPosterColor(design.palette.background, ink, 0.88), design.palette.background),
    priceMuted: mixPosterColor(design.palette.background, ink, 0.15), photo: mixPosterColor(design.palette.background, design.palette.accent, 0.1), wave: design.palette.accent,
  } : PALETTES[template];
  const headlineFont = design?.typography === "elegant" ? '"STSong", "SimSun", "Songti SC", serif' : FONT;
  const headlineWeight = design?.typography === "clean" ? 600 : 800;
  const align = design?.titleAlign ?? "left";
  const layout = design?.layout ?? "editorial";
  const pad = 64;
  const innerWidth = width - pad * 2;
  const background = ctx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, palette.background[0]);
  background.addColorStop(1, palette.background[1]);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  if (options.background) {
    const image = options.background;
    const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
    ctx.save();
    ctx.globalAlpha = 0.3;
    // 氛围层柔化，模型偶发的杂物或字样不会抢过商品实拍。
    ctx.filter = "blur(24px)";
    ctx.drawImage(image, (width - image.naturalWidth * scale) / 2, (height - image.naturalHeight * scale) / 2, image.naturalWidth * scale, image.naturalHeight * scale);
    ctx.restore();
  }

  // 留在边缘的海浪纹理；正文区保持清爽。
  ctx.save();
  ctx.strokeStyle = palette.wave;
  ctx.globalAlpha = 0.1;
  ctx.lineWidth = 2;
  for (let index = 0; index < (design?.decoration === "minimal" ? 0 : 5); index++) {
    ctx.beginPath();
    if (design?.decoration === "circles") ctx.arc(width - 20, 10, 120 + index * 56, 0, Math.PI * 2);
    else {
      ctx.moveTo(width - 330, -60 + index * 35);
      ctx.bezierCurveTo(width - 190, 170 + index * 30, width + 180, 70 + index * 60, width + 30, 360 + index * 35);
    }
    ctx.stroke();
  }
  ctx.restore();

  ctx.textBaseline = "top";
  if (options.background) roundedBox(ctx, pad - 10, 44, 338, 42, 10, palette.background[0]);
  roundedBox(ctx, pad, 54, 8, 24, 4, palette.accent);
  ctx.font = `600 23px ${FONT}`;
  ctx.fillStyle = readablePosterInk(palette.background[0], palette.accent);
  ctx.fillText("海产好物 · 商品推荐", pad + 22, 54);
  const showPoints = design?.showSellingPoints ?? true;
  const pointHeight = portrait ? 88 : 84;
  const priceEmphasis = design?.emphasis === "price";
  const priceY = (portrait ? 1134 : 850) - (priceEmphasis ? 20 : 0);
  const contentBottom = showPoints ? priceY - (portrait ? 28 : 18) - pointHeight - (portrait ? 24 : 18) : priceY - 24;
  const photoX = pad;
  let photoWidth = innerWidth, photoY = 112, photoBottom = contentBottom;
  if (layout === "split") {
    photoWidth = innerWidth * 0.58;
    const textX = pad + photoWidth + 32;
    const textWidth = innerWidth - photoWidth - 32;
    if (options.background) roundedBox(ctx, textX - 12, 112, textWidth + 24, contentBottom - 112, 20, palette.background[0]);
    const titleBottom = textBlock(ctx, copy.title, textX, portrait ? 174 : 142, textWidth, 6, portrait ? 62 : 48, 20, palette.ink, headlineWeight, portrait ? 400 : 280, headlineFont, align);
    if (design?.showSubtitle !== false) textBlock(ctx, copy.subtitle, textX, titleBottom + 24, textWidth, 7, 26, 16, palette.muted, 400, Math.max(140, contentBottom - titleBottom - 60));
  } else if (layout === "showcase") {
    // 按实际文字高度分配留白，短标题把空间让给商品大图。
    const titleFit = fitText(ctx, copy.title, innerWidth, 2, portrait ? 64 : 50, 28, headlineWeight, Infinity, headlineFont);
    const subtitleFit = design?.showSubtitle === false ? null : fitText(ctx, copy.subtitle, innerWidth, 3, portrait ? 26 : 22, 16, 400);
    const textHeight = titleFit.lines.length * titleFit.size * 1.25 + (subtitleFit ? 12 + subtitleFit.lines.length * subtitleFit.size * 1.25 : 0);
    photoBottom = contentBottom - 24 - textHeight;
    const textY = photoBottom + 24;
    if (options.background) roundedBox(ctx, pad - 12, textY - 12, innerWidth + 24, textHeight + 24, 20, palette.background[0]);
    const titleBottom = textBlock(ctx, copy.title, pad, textY, innerWidth, 2, titleFit.size, 28, palette.ink, headlineWeight, Infinity, headlineFont, align);
    if (subtitleFit) textBlock(ctx, copy.subtitle, pad, titleBottom + 12, innerWidth, 3, subtitleFit.size, 16, palette.muted, 400, Infinity, FONT, align);
  } else {
    const titleY = portrait ? 112 : 102;
    const titleFit = fitText(ctx, copy.title, innerWidth, 2, portrait ? 76 : 60, 28, headlineWeight, Infinity, headlineFont);
    const subtitleFit = design?.showSubtitle === false ? null : fitText(ctx, copy.subtitle, innerWidth, 3, portrait ? 28 : 24, 18, 400);
    const titleBottom = titleY + titleFit.lines.length * titleFit.size * 1.25;
    const subtitleBottom = titleBottom + (subtitleFit ? 12 + subtitleFit.lines.length * subtitleFit.size * 1.25 : 0);
    photoY = Math.max(portrait ? 280 : 240, subtitleBottom + 26);
    // 文案区为实色，避免生成背景中的文字或高对比纹理影响标题。
    if (options.background) roundedBox(ctx, 0, 90, width, photoY - 90, 0, palette.background[0]);
    textBlock(ctx, copy.title, pad, titleY, innerWidth, 2, titleFit.size, 28, palette.ink, headlineWeight, Infinity, headlineFont, align);
    if (subtitleFit) textBlock(ctx, copy.subtitle, pad, titleBottom + 12, innerWidth, 3, subtitleFit.size, 18, palette.muted, 400, Infinity, FONT, align);
  }
  const photoHeight = photoBottom - photoY;
  ctx.save();
  ctx.shadowColor = template === "ocean" ? "rgba(0,0,0,0.22)" : "rgba(36,63,54,0.10)";
  ctx.shadowBlur = 32;
  ctx.shadowOffsetY = 12;
  roundedBox(ctx, photoX, photoY, photoWidth, photoHeight, 28, palette.photo);
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(photoX, photoY, photoWidth, photoHeight, 28);
  ctx.clip();
  // 同一实拍的柔和背景填补宽高比留白；前景 contain 保留完整商品。
  const coverScale = Math.max(photoWidth / photo.naturalWidth, photoHeight / photo.naturalHeight);
  ctx.save();
  ctx.globalAlpha = 0.24;
  ctx.filter = "blur(26px)";
  ctx.drawImage(photo, photoX + (photoWidth - photo.naturalWidth * coverScale) / 2, photoY + (photoHeight - photo.naturalHeight * coverScale) / 2, photo.naturalWidth * coverScale, photo.naturalHeight * coverScale);
  ctx.restore();
  const availableWidth = photoWidth - 24;
  const availableHeight = photoHeight - 24;
  const scale = Math.min(availableWidth / photo.naturalWidth, availableHeight / photo.naturalHeight) * (design?.photoScale ?? 1);
  const imageWidth = photo.naturalWidth * scale;
  const imageHeight = photo.naturalHeight * scale;
  ctx.drawImage(photo, photoX + (photoWidth - imageWidth) / 2, photoY + (photoHeight - imageHeight) / 2, imageWidth, imageHeight);
  ctx.restore();

  const pointsY = contentBottom + (portrait ? 24 : 18);
  const pointWidth = (innerWidth - (copy.sellingPoints.length - 1) * 12) / copy.sellingPoints.length;
  (showPoints ? copy.sellingPoints : []).forEach((point, index) => {
    const x = pad + index * (pointWidth + 12);
    roundedBox(ctx, x, pointsY, pointWidth, pointHeight, 16, palette.card);
    roundedBox(ctx, x + 16, pointsY + 18, 4, pointHeight - 36, 2, palette.accent);
    const fit = fitText(ctx, point, pointWidth - 48, 3, portrait ? 28 : 24, 16, 600, pointHeight - 20);
    ctx.fillStyle = readablePosterInk(palette.card, palette.ink);
    const lineHeight = fit.size * 1.25;
    fit.lines.forEach((line, lineIndex) => ctx.fillText(line, x + 30, pointsY + (pointHeight - fit.lines.length * lineHeight) / 2 + lineIndex * lineHeight));
  });

  roundedBox(ctx, pad, priceY, innerWidth, (portrait ? 156 : 122) + (priceEmphasis ? 20 : 0), 24, palette.priceCard);
  ctx.font = `500 22px ${FONT}`;
  ctx.fillStyle = palette.priceMuted;
  ctx.fillText("商品售价", pad + 28, priceY + 18);
  const priceText = `¥${posterPrice(product.price)}`;
  fitText(ctx, priceText, innerWidth - 320, 1, (portrait ? 82 : 64) + (priceEmphasis ? 10 : 0), 40, 800);
  ctx.fillStyle = palette.priceInk;
  ctx.fillText(priceText, pad + 24, priceY + 48);
  const priceWidth = ctx.measureText(priceText).width;
  textBlock(ctx, product.unit, pad + priceWidth + 48, priceY + (portrait ? 74 : 62), innerWidth - priceWidth - 76, 2, 26, 16, palette.priceMuted, 400, portrait ? 72 : 52);

  const buttonY = portrait ? 1310 : 988;
  const buttonHeight = portrait ? 76 : 60;
  roundedBox(ctx, pad, buttonY, innerWidth, buttonHeight, 18, palette.soft);
  const ctaFit = fitText(ctx, copy.cta, innerWidth - 64, 2, portrait ? 30 : 26, 18, 600, buttonHeight - 12);
  ctx.fillStyle = readablePosterInk(palette.soft, palette.ink);
  const lineHeight = ctaFit.size * 1.2;
  ctaFit.lines.forEach((line, index) => {
    ctx.fillText(line, (width - ctx.measureText(line).width) / 2, buttonY + (buttonHeight - ctaFit.lines.length * lineHeight) / 2 + index * lineHeight);
  });

  if (portrait) {
    ctx.font = `400 20px ${FONT}`;
    ctx.fillStyle = palette.muted;
    ctx.fillText(options.background ? "海创Buddy · AI 创意背景 + 商品实拍" : "海创Buddy · 商品实拍海报", pad, 1404);
  }
  if (isDemo) {
    roundedBox(ctx, width - 228, 42, 164, 46, 23, palette.soft);
    ctx.font = `600 22px ${FONT}`;
    ctx.fillStyle = palette.ink;
    ctx.fillText("演示素材", width - 190, 52);
  }
  // 及早发现远程图片的跨域限制，避免预览成功却不能下载。
  ctx.getImageData(0, 0, 1, 1);
}

export function posterPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("海报导出失败，请重试。")), "image/png");
  });
}
