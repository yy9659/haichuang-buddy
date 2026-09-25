import * as React from "react";

import { cn } from "@/lib/utils";

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-1.5 text-[12px] leading-4 font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
