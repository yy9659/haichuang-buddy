"use client";

import { Check, Copy } from "lucide-react";
import * as React from "react";

export function CopyTextButton({ text, label = "复制回复" }: { text: string; label?: string }) {
  const [copied, setCopied] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
      title={failed ? "复制失败，请手动选中回答" : "复制后请核对事实，再到实际渠道发送"}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {failed ? "复制失败" : copied ? "已复制" : label}
    </button>
  );
}
