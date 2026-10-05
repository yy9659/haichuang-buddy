import type { ReactNode } from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import { guardAdminPage } from "@/lib/admin-page";

export const dynamic = "force-dynamic";
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await guardAdminPage();
  return <AdminShell user={{ name: user.name, email: user.email }}>{children}</AdminShell>;
}
