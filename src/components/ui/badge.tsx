import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[12px] leading-4 font-medium whitespace-nowrap [&_svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        primary: "border-blue-400/20 bg-blue-400/15 text-blue-300",
        soft: "border-blue-400/20 bg-blue-400/15 text-blue-300",
        secondary: "border-white/10 bg-white/10 text-slate-300",
        outline: "border-white/10 bg-white/5 text-slate-300",
        success: "border-cyan-400/20 bg-cyan-400/15 text-cyan-300",
        warning: "border-amber-400/20 bg-amber-400/15 text-amber-300",
        danger: "border-rose-400/20 bg-rose-400/15 text-rose-300",
        info: "border-info/20 bg-info/10 text-info",
        neutral: "border-white/10 bg-white/10 text-slate-300",
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
