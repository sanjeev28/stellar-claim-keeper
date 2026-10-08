import { Terminal } from "lucide-react";
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
    <div ref={ref} role="log" aria-label="Execution log" aria-live="polite" className="journal-output overflow-y-auto text-xs leading-relaxed">
      {logs.length === 0 && <div className="journal-empty"><Terminal className="mb-3 size-7 text-muted-foreground" /><span className="text-sm text-muted-foreground">Awaiting execution</span></div>}
      {logs.map((l) => (
        <div key={l.id} className={`break-words py-1 ${color[l.level]}`}>
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
