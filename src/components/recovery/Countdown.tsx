import { useEffect, useState } from "react";
import { setPreciseInterval } from "@/lib/stellar/timer";

export function Countdown({ target, label }: { target: number | null; label: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    return setPreciseInterval(() => setNow(Date.now()), 100);
  }, []);
  if (!target || now === null)
    return <div className="font-mono text-5xl text-muted-foreground">--:--:--</div>;
  const diff = target * 1000 - now;
  const past = diff <= 0;
  const abs = Math.abs(diff);
  const d = Math.floor(abs / 86400000);
  const h = Math.floor((abs % 86400000) / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  const s = Math.floor((abs % 60000) / 1000);
  const ds = Math.floor((abs % 1000) / 100);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    <div>
      <div className="text-xs uppercase tracking-widest text-muted-foreground">{past ? "Unlocked" : label}</div>
      <div className={`font-mono text-4xl font-semibold tabular-nums md:text-5xl ${past ? "text-success" : "text-primary"}`}>
        {past ? "+" : ""}
        {d > 0 && `${d}d `}
        {p(h)}:{p(m)}:{p(s)}
        <span className="text-2xl opacity-60">.{ds}</span>
      </div>
      <div className="mt-1 font-mono text-xs text-muted-foreground">{new Date(target * 1000).toISOString()}</div>
    </div>
  );
}
