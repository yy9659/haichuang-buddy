import { TaskMonitor } from "@/components/admin/task-monitor";
import { guardAdminPage } from "@/lib/admin-page";
import { getAdminOverview } from "@/services/admin.service";

export default async function MonitorPage() {
  await guardAdminPage();
  const overview = await getAdminOverview();
  return <TaskMonitor {...overview} />;
}
