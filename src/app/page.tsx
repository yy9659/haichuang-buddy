import { redirect } from "next/navigation";

/** 根路由直接进入 AI 经营驾驶舱 */
export default function RootPage() {
  redirect("/dashboard");
}
