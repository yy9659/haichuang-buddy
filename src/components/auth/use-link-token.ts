"use client";

import { useEffect, useState } from "react";

export function useLinkToken(enabled: boolean) {
  const [token, setToken] = useState("");
  useEffect(() => {
    if (!enabled || !location.hash) return;
    const value = location.hash.slice(1);
    history.replaceState(history.state, "", location.pathname + location.search);
    if (/^[A-Za-z0-9_-]{43}$/.test(value)) setToken(value);
  }, [enabled]);
  return [token, setToken] as const;
}
