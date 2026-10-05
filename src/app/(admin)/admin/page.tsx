import { CommandDashboard } from "@/components/admin/command-dashboard";
import { guardAdminPage } from "@/lib/admin-page";
import { getAdminOverview } from "@/services/admin.service";

export default async function AdminPage() {
  await guardAdminPage();
  const overview = await getAdminOverview();
  return <CommandDashboard {...overview} />;
}
