import type { Metadata } from "next";

import { AppProviders } from "@/components/providers/app-providers";

import "./globals.css";

export const metadata: Metadata = {
  title: "海创Buddy · 连江海产 AI 一人公司增长智能体",
  description:
    "海创Buddy 是一套面向连江海产品经营者的 AI 一人公司增长智能体：一个人，也可以拥有一支 AI 经营团队。",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" className="h-full">
      <body className="min-h-full antialiased">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
