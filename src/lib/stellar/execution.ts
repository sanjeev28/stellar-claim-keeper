export type TimingMode = "fixed" | "ledger";
export const LEDGER_GATE_START_MS = 15_000;
export const LEDGER_POLL_MS = 250;
export const LEDGER_SECONDS = 5;

export function ledgerGateOpen(closeTime: number, unlockAt: number) {
  return closeTime + 2 * LEDGER_SECONDS >= unlockAt;
}

export function configuredEndpoints(primary: string, extra: string): string[] {
  return [primary, ...extra.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)];
}

export function validateEndpoints(endpoints: string[]) {
  if (!endpoints.length) throw new Error("Configure at least one Horizon endpoint.");
  for (const endpoint of endpoints) {
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new Error("Each endpoint must be a complete http:// or https:// URL."); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Endpoints must use HTTP(S) without embedded credentials.");
    }
  }
}

export type ExecutionResult = {
  result: "successful" | "failed" | "dry_run" | "unconfirmed";
  hash: string | null;
  ledger: number | null;
  feePaid: string | null;
  code: string | null;
  amount: string;
  assetLabel: string;
};

export function balanceStatus(balance: { unlockAt: number | null; expiresAt: number | null }, now: number) {
  if (balance.expiresAt !== null && now >= balance.expiresAt) return "EXPIRED";
  if (balance.unlockAt === null) return "NOT CLAIMABLE";
  return now >= balance.unlockAt ? "CLAIMABLE" : "LOCKED";
}