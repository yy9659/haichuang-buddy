/**
 * 演示商家的种子数据（**唯一来源**）
 *
 * 这里的常量被两处使用：
 * 1. `scripts/seed.ts` —— 命令行把演示数据灌进当前数据库（`pnpm db:seed`）；
 * 2. `@/services/business-provisioning.service` —— 新账号注册时，给 TA 灌一份
 *    **属于自己的**商家档案 + 商品 + 知识库，使新用户登录后看到的不是空页面。
 *
 * 放在 `src/lib/mock` 而不是脚本目录，是因为第 2 条：服务层不能 import 脚本目录。
 * 两份数据各写一遍必然漂 —— 而「脚本灌的数据」与「注册灌的数据」不一致，
 * 会让「我按文档 seed 过，怎么和截图不一样」变成一个查不出原因的问题。
 *
 * 注意：这些是**演示**数据，不是「系统预置」。`seedDemoBusinessData()` 只会
 * 往一个**空**商家下写，已存在同名的商品 / 知识文档时跳过，绝不覆盖用户改过的内容。
 */

/** 演示商家档案 */
export const DEMO_BUSINESS = {
  name: "连江海创海产商贸",
  shortName: "海创海产",
  description:
    "连江县黄岐半岛海产直供：鲜活鲍鱼、黄岐海带与手工鱼丸，产地直发、顺丰冷链。",
  owner: "陈老板",
  location: "福建省福州市连江县黄岐半岛",
  mainCategory: "海产品 / 干货 / 预制菜",
  storeCount: 3,
  channels: ["douyin", "wechat", "store"],
} as const;

/** 演示老板数字分身 */
export const DEMO_OWNER = {
  displayName: "陈老板",
  avatarLabel: "陈",
  businessPhilosophy: [
    "产地直发，不经过二次转手",
    "先把品质讲清楚，再谈价格",
    "顾客问什么就答什么，不夸大",
  ],
  tone: ["实在", "专业", "带点海边人的直爽"],
  salesStyle:
    "先讲产地与新鲜度，再谈规格与价格；对犹豫的顾客主动给烹饪与储存建议。",
  targetCustomers: [
    "25-40 岁家庭采购者（宝妈 / 宝爸）",
    "注重食品安全的中产家庭",
    "节庆送礼人群",
  ],
  forbiddenExpressions: [
    "绝对新鲜 / 100% 新鲜（无依据的绝对化表述）",
    "任何治疗、药用功效暗示",
    "国家级 / 最 等极限词",
  ],
} as const;

/** 演示商品 */
export interface DemoProduct {
  name: string;
  description: string;
  category: "海产品" | "干货" | "预制菜" | "礼盒";
  subCategory: string;
  price: number;
  unit: string;
  stock: number;
  origin: string;
  specification: string;
  storageMethod: string;
  shelfLife: string;
  tags: string[];
  /** 对应 `scripts/lib/sample-image.ts` 的 `SAMPLE_PALETTES` 键（脚本生成示例图用） */
  palette: string;
  imageSeed: number;
}

export const DEMO_PRODUCTS: DemoProduct[] = [
  {
    name: "连江鲜活鲍鱼",
    description:
      "黄岐半岛深海筏式养殖，当日捕捞当日发。壳面洁净、肉质紧实，适合白灼、蒜蓉蒸与老火汤。",
    category: "海产品",
    subCategory: "鲍鱼",
    price: 128.5,
    unit: "500g",
    stock: 60,
    origin: "福建连江 · 黄岐半岛",
    specification: "8-10 头 / 500g",
    storageMethod: "0-4℃ 冷藏，勿离水过夜",
    shelfLife: "2 天",
    tags: ["鲜活", "产地直发", "顺丰冷链"],
    palette: "seafood",
    imageSeed: 20260925,
  },
  {
    name: "黄岐海带",
    description:
      "浅海天然日晒，厚实有嚼劲。免洗无沙，泡发后适合凉拌、炖排骨与海带豆腐汤。",
    category: "干货",
    subCategory: "海带",
    price: 39.9,
    unit: "500g",
    stock: 180,
    origin: "福建连江 · 黄岐半岛",
    specification: "干度足 / 500g",
    storageMethod: "阴凉干燥处密封保存，避免受潮",
    shelfLife: "12 个月",
    tags: ["日晒", "免洗", "煲汤"],
    palette: "dried",
    imageSeed: 20260926,
  },
  {
    name: "连江手工鱼丸",
    description:
      "选用当日深海鳗鱼手工捶打，弹牙有嚼劲，无添加。火锅、煮汤、煎制都合适。",
    category: "预制菜",
    subCategory: "鱼丸",
    price: 45,
    unit: "袋",
    stock: 40,
    origin: "福建连江",
    specification: "500g / 袋（约 20 颗）",
    storageMethod: "-18℃ 冷冻保存",
    shelfLife: "90 天",
    tags: ["手工", "火锅必备", "无添加"],
    palette: "prepared",
    imageSeed: 20260927,
  },
];

/**
 * mock 知识种子里的 `productId` 占位串 → `DEMO_PRODUCTS` 下标。
 *
 * `MOCK_KNOWLEDGE_DOCUMENTS` 用的是 `prod_001` 这类**占位 id**（Mock 世界的 id），
 * 而真实数据库里的商品 id 是 uuid。两者之间只有「第几个商品」这一层对应关系，
 * 所以映射按**顺序**定义，不依赖占位字符串本身 —— 将来 mock 里改名了这里仍然有效。
 */
export const SEED_PRODUCT_ID_TO_INDEX: Record<string, number> = {
  prod_001: 0, // 连江鲜活鲍鱼
  prod_003: 1, // 黄岐海带
  prod_005: 2, // 连江手工鱼丸
};

/**
 * 把知识种子里的 `productId` 占位串翻译成**某个商家真实的**商品 id。
 *
 * `idByName` 必须是该商家的「商品名 → id」表：知识可以挂商品，
 * 挂错商品的知识会被另一个商家的消费者检索到，而且不会报错。
 * 翻译不出来时返回 null（按「全店知识」处理），**不要**退回到某个默认商品。
 */
export function resolveSeedProductId(
  seed: { productId: string | null },
  idByName: Map<string, string>,
): string | null {
  if (!seed.productId) {
    return null;
  }
  const index = SEED_PRODUCT_ID_TO_INDEX[seed.productId];
  if (index === undefined) {
    return null;
  }
  const name = DEMO_PRODUCTS[index]?.name;
  return name ? (idByName.get(name) ?? null) : null;
}
