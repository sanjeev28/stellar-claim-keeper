import { afterEach, describe, expect, it, vi } from "vitest";
import { Account, Asset, Horizon, Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { RecoveryEngine, fetchClaimableBalances, feeUnits, type BalanceInfo, type EngineConfig } from "./engine";
import { NETWORKS } from "./networks";

vi.mock("./timer", () => ({ preciseSleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) }));

function fixture(overrides: Partial<EngineConfig> = {}) {
  const claimant = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(1));
  const vault = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(2));
  const network = NETWORKS.find((n) => n.id === "stellar-testnet");
  if (!network) throw new Error("Missing testnet");
  const unlockAt = Math.floor(Date.now() / 1000);
  const balance: BalanceInfo = { id: `00000000${"ab".repeat(32)}`, amount: "12.3456789", asset: Asset.native(), assetLabel: "XLM", claimant: claimant.publicKey(), predicateText: "unconditional", unlockAt, expiresAt: null, claimableNow: true };
  const config: EngineConfig = { network, horizons: [network.horizon, "https://second.test"], balanceId: balance.id, claimant, destination: vault.publicKey(), perOpFee: 50000000, baseFee: 100, feeBump: true, escalate: false, maxPerOpFee: 150000000, leadMs: 1500, burstIntervalMs: 80, windowSec: 2, mergeAccount: false, timingMode: "fixed", dryRun: false, ...overrides };
  vi.spyOn(Horizon.Server.prototype, "loadAccount").mockImplementation(async (pk) => Object.assign(new Account(pk, "10"), { balances: [] }) as unknown as Awaited<ReturnType<Horizon.Server["loadAccount"]>>);
  return { balance, config };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("End-to-end recovery engine", () => {
  it("builds a locally signed fee-bump with claim and full payment but never submits in dry-run", async () => {
    const { balance, config } = fixture({ dryRun: true });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const result = await new RecoveryEngine(config, vi.fn()).run(balance);
    expect(result.result).toBe("dry_run");
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("broadcasts signed atomic claim/payment to all endpoints and reports actual charged fee", async () => {
    const { balance, config } = fixture();
    const envelopes: string[] = [];
    const posts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(url); envelopes.push(new URLSearchParams(String(init.body)).get("tx") ?? "");
        return new Response(JSON.stringify({ successful: true, hash: "a".repeat(64), ledger: 123, fee_charged: "300" }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }));
    const result = await new RecoveryEngine(config, vi.fn()).run(balance);
    expect(posts).toEqual(config.horizons.map((h) => `${h}/transactions`));
    expect(envelopes[0]).toBe(envelopes[1]);
    const envelope = TransactionBuilder.fromXDR(envelopes[0] ?? "", config.network.passphrase);
    expect("innerTransaction" in envelope).toBe(true);
    if (!("innerTransaction" in envelope)) throw new Error("Expected fee bump");
    expect(envelope.innerTransaction.operations.map((o) => o.type)).toEqual(["claimClaimableBalance", "payment"]);
    expect(envelope.innerTransaction.operations[1]).toMatchObject({ amount: "12.3456789", destination: config.destination });
    expect(envelope.innerTransaction.timeBounds?.minTime).toBe(String(balance.unlockAt));
    expect(result).toMatchObject({ result: "successful", ledger: 123, amount: "12.3456789", feePaid: "0.0000300" });
  });
  it("marks an included predicate failure Failed, never successful", async () => {
    const { balance, config } = fixture();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === "POST" ? { successful: false, hash: "b".repeat(64), ledger: 124, fee_charged: "300", extras: { result_codes: { transaction: "tx_fee_bump_inner_failed", operations: ["op_cannot_claim"] } } } : {}), { status: init?.method === "POST" ? 400 : 404 })));
    const result = await new RecoveryEngine(config, vi.fn()).run(balance);
    expect(result.result).toBe("failed");
    expect(result.code).toContain("op_cannot_claim");
    expect(result.feePaid).toBe("0.0000300");
  });
  it("keeps 80ms cadence even while prior submissions are waiting", async () => {
    vi.useFakeTimers();
    const { balance, config } = fixture();
    const times: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return new Response("{}", { status: 404 });
      times.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 400));
      return new Response(JSON.stringify({ successful: true, hash: "c".repeat(64), ledger: 125, fee_charged: "300" }));
    }));
    const running = new RecoveryEngine(config, vi.fn()).run(balance);
    await vi.advanceTimersByTimeAsync(500);
    expect((await running).result).toBe("successful");
    expect((times[2] ?? -1) - (times[0] ?? 0)).toBe(80);
  });
  it("fetches subsequent Horizon pages instead of truncating at first page", async () => {
    const claimant = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(3)).publicKey();
    const record = (id: string) => ({ id, amount: "1", asset: "native", claimants: [{ destination: claimant, predicate: { unconditional: true } }] });
    const empty = { records: [], next: vi.fn() };
    const second = { records: [record("second")], next: vi.fn().mockResolvedValue(empty) };
    const first = { records: [record("first")], next: vi.fn().mockResolvedValue(second) };
    const builder = { claimant: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), call: vi.fn().mockResolvedValue(first) };
    vi.spyOn(Horizon.Server.prototype, "claimableBalances").mockReturnValue(builder as unknown as ReturnType<Horizon.Server["claimableBalances"]>);
    const result = await fetchClaimableBalances("https://api.mainnet.minepi.com", claimant, "Pi");
    expect(result.map((b) => b.id)).toEqual(["first", "second"]);
    expect(first.next).toHaveBeenCalledOnce();
    expect(second.next).toHaveBeenCalledOnce();
  });
  it("converts actual stroops exactly without rounding", () => { expect(feeUnits("123456789")).toBe("12.3456789"); });
});