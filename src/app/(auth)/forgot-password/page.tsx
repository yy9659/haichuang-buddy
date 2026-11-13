import { AuthVideoShell } from "@/components/auth/auth-video-shell";
import { AccountMailForm } from "@/components/auth/account-mail-form";

export default function ForgotPasswordPage() {
  return <AuthVideoShell title="忘记密码" description="填写邮箱，申请重设密码。">
    <AccountMailForm mode="forgot" />
  </AuthVideoShell>;
}
