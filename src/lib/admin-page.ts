import { redirect } from "next/navigation";
import { getCurrentAuthUser } from "@/services/auth.service";

export async function guardAdminPage() {
  const user = await getCurrentAuthUser();
  if (!user) redirect("/login?next=/admin");
  if (user.role !== "admin") redirect("/dashboard");
  return user;
}
