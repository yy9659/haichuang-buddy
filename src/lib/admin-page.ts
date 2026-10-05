import { redirect } from "next/navigation";
import { isAdminEmail } from "@/lib/admin";
import { getServerEnv } from "@/lib/env";
import { getCurrentAuthUser } from "@/services/auth.service";

export async function guardAdminPage() {
  const user = await getCurrentAuthUser();
  if (!user) redirect("/login?next=/admin");
  if (!isAdminEmail(user.email, getServerEnv().ADMIN_EMAILS)) redirect("/dashboard");
  return user;
}
