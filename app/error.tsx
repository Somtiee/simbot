"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("App error boundary caught:", error);
  }, [error]);

  return (
    <div className="grid min-h-screen place-items-center bg-zinc-950 p-6 text-zinc-100">
      <div className="w-full max-w-xl rounded-lg border border-rose-500/40 bg-zinc-900/70 p-6 text-center">
        <h2 className="text-xl font-semibold text-rose-200">Agent crashed on task flow — retry?</h2>
        <p className="mt-2 text-sm text-zinc-300">
          Something unexpected happened while rendering the dashboard.
        </p>
        <Button className="mt-4" onClick={reset}>
          Retry
        </Button>
      </div>
    </div>
  );
}
