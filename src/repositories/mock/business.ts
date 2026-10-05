import { MOCK_BUSINESS, MOCK_OWNER_TWIN } from "@/lib/mock";
import { MOCK_AGENT_NOTIFICATIONS } from "@/lib/mock/notifications";
import type { BusinessProfile, OwnerTwin } from "@/types";

import type {
  BusinessRepository,
  NewBusinessInput,
  UpdateBusinessInput,
  UpdateOwnerTwinInput,
} from "../types";

/** 进程内可变副本；初始值与 Phase 0 的 Mock 常量完全一致 */
const businessProfile: BusinessProfile = {
  ...MOCK_BUSINESS,
  channels: [...MOCK_BUSINESS.channels],
};

const ownerTwin: OwnerTwin = {
  ...MOCK_OWNER_TWIN,
  businessPhilosophy: [...MOCK_OWNER_TWIN.businessPhilosophy],
  tone: [...MOCK_OWNER_TWIN.tone],
  targetCustomers: [...MOCK_OWNER_TWIN.targetCustomers],
  forbiddenExpressions: [...MOCK_OWNER_TWIN.forbiddenExpressions],
};

/** 商家 / 老板数字分身 / 通知的 Mock 实现（S0 起使用，S1-1 补齐写操作） */
export function createMockBusinessRepository(): BusinessRepository {
  return {
    async getProfile() {
      return businessProfile;
    },

    /**
     * Mock 只有这一个商家，所以「最早的商家」就是它自己 —— 恒非 null。
     * 这直接决定了 Mock 下的注册流程会走「认领」分支（账号挂在演示商家下），
     * 与真实数据源「首次注册认领 seed 商家」的行为一致。
     */
    async findEarliestProfile() {
      return businessProfile;
    },

    /**
     * Mock 是**单商家**演示环境 —— `MOCK_BUSINESS.id` 是整个 Mock 数据图的锚点
     * （商品、内容、知识库、会话全挂在它下面）。再造一个商家，那些数据就全失联了。
     *
     * 因此这里不新建，直接返回已有的那一个：**Mock 下所有账号共享同一份演示数据**。
     * 这是 Mock 与数据库实现**已知且有意的**一处不一致，不是漏实现 ——
     * 真正的多租户隔离只在 `DATA_SOURCE=local` / `db` 下成立，
     * 那本来也不是 Mock 的职责（Mock 的职责是「零依赖地把界面跑起来」）。
     *
     * 这样做还有一个实际好处：`pnpm dev`（默认 mock）下注册第二个账号不会失败，
     * 只是两人看到同一份演示数据 —— 比「注册按钮点了报错」好得多。
     */
    async create(_input: NewBusinessInput) {
      void _input;
      return businessProfile;
    },

    async updateProfile(patch: UpdateBusinessInput) {
      Object.assign(businessProfile, patch);
      if (patch.channels) {
        businessProfile.channels = [...patch.channels];
      }
      return businessProfile;
    },

    async getOwnerTwin() {
      return ownerTwin;
    },

    async updateOwnerTwin(
      patch: UpdateOwnerTwinInput,
      _options?: { businessId?: string },
    ) {
      // 单商家环境：显式传入的 businessId 无从落地（只有一个分身），
      // 但签名必须与数据库实现一致，否则上层要按数据源分叉。
      Object.assign(ownerTwin, patch);
      return ownerTwin;
    },

    async listNotifications() {
      return MOCK_AGENT_NOTIFICATIONS.map((notification) => ({ ...notification }));
    },
  };
}
