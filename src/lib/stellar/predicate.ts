export type HorizonPredicate = {
  unconditional?: boolean;
  and?: HorizonPredicate[];
  or?: HorizonPredicate[];
  not?: HorizonPredicate;
  abs_before?: string;
  abs_before_epoch?: string;
  rel_before?: string;
};

const absEpoch = (p: HorizonPredicate) =>
  p.abs_before_epoch ? Number(p.abs_before_epoch) : Math.floor(Date.parse(p.abs_before!) / 1000);

/** Evaluate predicate at unix time t (seconds). createdAt anchors rel_before. */
export function evaluate(p: HorizonPredicate, t: number, createdAt: number): boolean {
  if (p.unconditional) return true;
  if (p.and) return p.and.every((x) => evaluate(x, t, createdAt));
  if (p.or) return p.or.some((x) => evaluate(x, t, createdAt));
  if (p.not) return !evaluate(p.not, t, createdAt);
  if (p.abs_before || p.abs_before_epoch) return t < absEpoch(p);
  if (p.rel_before) return t < createdAt + Number(p.rel_before);
  return true;
}

function boundaries(p: HorizonPredicate, createdAt: number, out: number[]) {
  if (p.and) p.and.forEach((x) => boundaries(x, createdAt, out));
  if (p.or) p.or.forEach((x) => boundaries(x, createdAt, out));
  if (p.not) boundaries(p.not, createdAt, out);
  if (p.abs_before || p.abs_before_epoch) out.push(absEpoch(p));
  if (p.rel_before) out.push(createdAt + Number(p.rel_before));
}

export type Window = { unlockAt: number | null; expiresAt: number | null; claimableNow: boolean };

/** Find the earliest claimable second >= now and when that window closes. */
export function claimWindow(p: HorizonPredicate, createdAt: number, now: number): Window {
  const pts: number[] = [];
  boundaries(p, createdAt, pts);
  const candidates = [now, ...pts.filter((x) => x > now)].sort((a, b) => a - b);
  const claimableNow = evaluate(p, now, createdAt);
  let unlockAt: number | null = null;
  for (const c of candidates) {
    if (evaluate(p, c, createdAt)) {
      unlockAt = c;
      break;
    }
  }
  let expiresAt: number | null = null;
  if (unlockAt !== null) {
    for (const b of pts.filter((x) => x > unlockAt!).sort((a, b) => a - b)) {
      if (!evaluate(p, b, createdAt)) {
        expiresAt = b;
        break;
      }
    }
  }
  return { unlockAt, expiresAt, claimableNow };
}

export function describe(p: HorizonPredicate): string {
  if (p.unconditional) return "unconditional";
  if (p.and) return `(${p.and.map(describe).join(" AND ")})`;
  if (p.or) return `(${p.or.map(describe).join(" OR ")})`;
  if (p.not) return `NOT ${describe(p.not)}`;
  if (p.abs_before || p.abs_before_epoch)
    return `before ${new Date(absEpoch(p) * 1000).toISOString()}`;
  if (p.rel_before) return `within ${p.rel_before}s of creation`;
  return "?";
}
