import type { BusinessProfile, OwnerTwin } from "@/types";

/** Demo 商家：连江海产一人公司 */
export const MOCK_BUSINESS: BusinessProfile = {
  id: "biz_demo_001",
  name: "连江海创海产商贸",
  shortName: "海创海产",
  owner: "陈老板",
  location: "福建省福州市连江县黄岐半岛",
  mainCategory: "连江海产品",
  storeCount: 1,
  channels: ["抖音小店", "视频号", "微信社群"],
};

/** 老板数字分身 Owner Twin */
export const MOCK_OWNER_TWIN: OwnerTwin = {
  displayName: "陈老板",
  avatarLabel: "陈",
  businessPhilosophy: ["真实", "诚信", "新鲜"],
  tone: ["亲切", "自然", "不夸张"],
  salesStyle: "专业介绍，不强迫消费",
  targetCustomers: ["年轻家庭", "品质消费者", "节庆礼赠人群"],
  forbiddenExpressions: ["绝对第一", "全网最低", "包治百病", "100% 无风险"],
};
