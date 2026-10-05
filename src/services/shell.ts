import type {
  AgentNotification,
  BusinessProfile,
  OwnerTwin,
} from "@/types";
import { getRepositories } from "@/repositories";
import { attempt, toAppError, type Result } from "@/lib/result";

/** 全局外壳（侧边栏 + 顶部栏）所需数据 */
export interface ShellView {
  business: BusinessProfile | null;
  owner: OwnerTwin | null;
  notifications: AgentNotification[];
  unreadCount: number;
}

export async function getShellView(): Promise<Result<ShellView>> {
  return attempt(
    async () => {
      const repositories = getRepositories();
      const [business, owner, notifications] = await Promise.all([
        repositories.business.getProfile(),
        repositories.business.getOwnerTwin(),
        repositories.business.listNotifications(),
      ]);

      return {
        business,
        owner,
        notifications,
        unreadCount: notifications.filter((item) => !item.read).length,
      };
    },
    (cause) => toAppError(cause, "DB_ERROR", "加载全局信息失败"),
  );
}
