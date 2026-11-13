import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[12px] leading-4 font-medium whitespace-nowrap [&_svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        primary:
          "border-blue-600/20 bg-blue-600/10 text-blue-700 dark:border-blue-400/20 dark:bg-blue-400/15 dark:text-blue-300",
        soft: "border-blue-600/20 bg-blue-600/10 text-blue-700 dark:border-blue-400/20 dark:bg-blue-400/15 dark:text-blue-300",
        secondary:
          "border-slate-900/10 bg-slate-900/5 text-slate-600 dark:border-white/10 dark:bg-white/10 dark:text-slate-300",
        outline:
          "border-slate-900/10 bg-slate-900/[0.03] text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300",
        success:
          "border-cyan-600/20 bg-cyan-600/10 text-cyan-700 dark:border-cyan-400/20 dark:bg-cyan-400/15 dark:text-cyan-300",
        warning:
          "border-amber-600/25 bg-amber-500/10 text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/15 dark:text-amber-300",
        danger:
          "border-rose-600/20 bg-rose-600/10 text-rose-700 dark:border-rose-400/20 dark:bg-rose-400/15 dark:text-rose-300",
        info: "border-info/20 bg-info/10 text-info",
        neutral:
          "border-slate-900/10 bg-slate-900/5 text-slate-600 dark:border-white/10 dark:bg-white/10 dark:text-slate-300",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export type BadgeProps = React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants>;

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
