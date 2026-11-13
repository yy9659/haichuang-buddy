import { AuthVideoShell } from "@/components/auth/auth-video-shell";
import { AccountMailForm } from "@/components/auth/account-mail-form";

export default function ResetPasswordPage() {
  return <AuthVideoShell title="重设密码" description="设置新密码后，其他设备会退出登录。">
    <AccountMailForm mode="reset" />
  </AuthVideoShell>;
}
