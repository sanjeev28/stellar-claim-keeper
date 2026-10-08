import { useEffect, useRef } from "react";
import type { LogEntry } from "@/lib/stellar/engine";

const color: Record<LogEntry["level"], string> = {
  info: "text-foreground",
  ok: "text-success",
  warn: "text-warning",
  error: "text-destructive",
  net: "text-info",
};

export function Console({ logs, explorer }: { logs: LogEntry[]; explorer: (h: string) => string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [logs]);
  return (
    <div ref={ref} className="h-[420px] overflow-y-auto rounded-md border bg-background p-3 font-mono text-xs leading-relaxed">
      {logs.length === 0 && <div className="text-muted-foreground">$ awaiting execution…</div>}
      {logs.map((l) => (
        <div key={l.id} className={color[l.level]}>
          <span className="text-muted-foreground">{new Date(l.at).toISOString().slice(11, 23)} </span>
          <span className="uppercase opacity-70">[{l.level}]</span> {l.msg}
          {l.hash && (
            <a href={explorer(l.hash)} target="_blank" rel="noreferrer" className="ml-2 underline text-info">
              {l.hash.slice(0, 16)}… ↗
            </a>
          )}
          {l.details?.map((d, i) => (
            <div key={i} className="pl-6 opacity-80">
              ↳ {d}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
