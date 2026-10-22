import { describe, expect, it } from "vitest";
import { balanceStatus, configuredEndpoints, LEDGER_GATE_START_MS, LEDGER_POLL_MS, ledgerGateOpen } from "./execution";
import { claimWindow } from "./predicate";
import { historyPayload } from "@/lib/history";

describe("Recovery rules", () => {
  it("starts ledger gate 15 seconds before unlock", () => { expect(LEDGER_GATE_START_MS).toBe(15000); });
  it("samples ledger gate every 250 ms", () => { expect(LEDGER_POLL_MS).toBe(250); });
  it("gates on two five-second ledgers", () => {
    expect(ledgerGateOpen(89, 100)).toBe(false);
    expect(ledgerGateOpen(90, 100)).toBe(true);
  });
  it("counts every non-empty endpoint line plus primary", () => {
    expect(configuredEndpoints("https://api.mainnet.minepi.com", "\n https://one.test \r\n\nhttp://two.test\n")).toEqual(["https://api.mainnet.minepi.com", "https://one.test", "http://two.test"]);
  });
  it("derives exact unlock from claimant predicate", () => {
    expect(claimWindow({ not: { abs_before_epoch: "1000" } }, 0, 990)).toEqual({ unlockAt: 1000, expiresAt: null, claimableNow: false });
  });
  it("marks an expired target unavailable", () => { expect(balanceStatus({ unlockAt: 100, expiresAt: 200 }, 200)).toBe("EXPIRED"); });
  it("never includes credentials or signed envelopes in history", () => {
    const run = { networkId: "pi-mainnet", balanceId: "balance", amount: "12", assetLabel: "Pi", unlockAt: 1000, dryRun: true, credential: "SECRET_SENTINEL", envelope: "SIGNED_SENTINEL" };
    const payload = historyPayload(run, { result: "dry_run", hash: "hash", ledger: null, feePaid: null, code: null, amount: "12", assetLabel: "Pi" });
    expect(payload).toEqual({ network_id: "pi-mainnet", balance_id: "balance", amount: "12", asset_label: "Pi", unlock_time: "1970-01-01T00:16:40.000Z", dry_run: true, result: "dry_run", tx_hash: "hash", ledger: null, fee_paid: null, result_code: null });
    expect(JSON.stringify(payload)).not.toContain("SENTINEL");
  });
});