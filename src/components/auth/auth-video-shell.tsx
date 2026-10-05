import type { ReactNode } from "react";

import { BrandMark } from "@/components/layout/brand-mark";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface AuthVideoShellProps {
  title: string;
  description: string;
  children: ReactNode;
}

/** 登录与注册共用的视频背景和右侧毛玻璃面板。 */
export function AuthVideoShell({
  title,
  description,
  children,
}: AuthVideoShellProps) {
  return (
    <div className="relative isolate min-h-dvh overflow-hidden bg-[#071e36]">
      <video
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
        className="absolute inset-0 z-0 h-full w-full object-cover"
        src="/assets/ocean-bg.mp4"
      />
      <div aria-hidden="true" className="absolute inset-0 z-[1] bg-black/30" />
      <div
        aria-hidden="true"
        className="absolute inset-0 z-[1] bg-gradient-to-r from-transparent via-[#041e38]/10 to-[#041e38]/55"
      />

      <div className="relative z-10 mx-auto flex min-h-dvh w-full max-w-[1440px] items-center justify-center px-4 py-10 sm:px-8 lg:justify-end lg:px-16 xl:px-24">
        <main className="w-full max-w-[440px]">
          <Card className="rounded-2xl border border-white/20 bg-white/10 text-white shadow-2xl backdrop-blur-md hover:shadow-2xl">
            <CardHeader className="flex-col items-start gap-0 px-6 pt-8 pb-5 sm:px-8 sm:pt-9">
              <BrandMark showSubtitle={false} onDark large className="mb-7" />
              <CardTitle className="text-[25px] leading-tight font-semibold text-white">
                {title}
              </CardTitle>
              <CardDescription className="mt-1 text-sm leading-6 text-white/80">
                {description}
              </CardDescription>
            </CardHeader>
            <CardContent className="px-6 pb-8 sm:px-8 sm:pb-9">
              {children}
            </CardContent>
          </Card>
        </main>
      </div>
    </div>
  );
}
