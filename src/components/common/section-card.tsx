import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type * as React from "react";

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface SectionCardProps {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  /** 右上角「查看全部」链接 */
  moreHref?: string;
  moreLabel?: string;
  /** 右上角自定义操作 */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
}

/** 页面内统一的分区卡片容器 */
export function SectionCard({
  title,
  description,
  icon,
  moreHref,
  moreLabel = "查看全部",
  action,
  children,
  className,
  contentClassName,
}: SectionCardProps) {
  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader>
        <div className="flex flex-col gap-0.5">
          <CardTitle>
            {icon}
            {title}
          </CardTitle>
          {description ? (
            <CardDescription>{description}</CardDescription>
          ) : null}
        </div>
        {action ?? (
          moreHref ? (
            <CardAction>
              <Link
                href={moreHref}
                className="inline-flex items-center gap-0.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-primary"
              >
                {moreLabel}
                <ArrowRight className="size-3.5" />
              </Link>
            </CardAction>
          ) : null
        )}
      </CardHeader>
      <CardContent className={cn("flex-1", contentClassName)}>
        {children}
      </CardContent>
    </Card>
  );
}
