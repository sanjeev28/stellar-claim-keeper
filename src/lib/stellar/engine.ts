import "@/lib/stellar/polyfill";
import { Buffer } from "buffer";
import {
  Asset,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  xdr,
  type FeeBumpTransaction,
  type Transaction,
} from "@stellar/stellar-sdk";
import { claimWindow, describe, type HorizonPredicate } from "./predicate";
import { diagnose, txCode } from "./errors";
import type { NetworkPreset } from "./networks";
import { preciseSleep } from "./timer";
import { LEDGER_GATE_START_MS, LEDGER_POLL_MS, ledgerGateOpen, validateEndpoints, type ExecutionResult, type TimingMode } from "./execution";

export type LogLevel = "info" | "ok" | "warn" | "error" | "net";
export type LogEntry = { id: number; at: number; level: LogLevel; msg: string; details?: string[]; hash?: string };
export type Logger = (level: LogLevel, msg: string, extra?: { details?: string[]; hash?: string }) => void;

export type BalanceInfo = {
  id: string;
  amount: string;
  asset: Asset;
  assetLabel: string;
  sponsor?: string | undefined;
  claimant: string;
  predicateText: string;
  unlockAt: number | null;
  expiresAt: number | null;
  claimableNow: boolean;
};

export type FeeStats = { min: number; p50: number; p90: number; p99: number; capacity: string };

export type EngineConfig = {
  network: NetworkPreset;
  horizons: string[];
  balanceId: string;
  claimant: Keypair;
  destination: string;
  perOpFee: number; // stroops
  baseFee: number; // network minimum per op (stroops)
  feeBump: boolean;
  feeSource?: Keypair | undefined;
  escalate: boolean;
  maxPerOpFee: number; // stroops cap for escalation
  leadMs: number; // start firing this many ms before unlock
  burstIntervalMs: number;
  windowSec: number; // maxTime = unlock + windowSec
  mergeAccount: boolean;
  timingMode: TimingMode;
  dryRun: boolean;
};

const sleep = preciseSleep;
const SUBMIT_TIMEOUT_MS = 1500;

/** Fire keepalive HEAD pings so TCP/TLS handshakes are hot before unlock. */
export function prewarm(horizons: string[]) {
  return Promise.all(
    horizons.map((h) =>
      fetch(h, { method: "HEAD", mode: "no-cors", cache: "no-store", keepalive: true }).catch(() => null),
    ),
  );
}

const assetFromString = (s: string) => {
  if (s === "native") return Asset.native();
  const [code, issuer] = s.split(":");
  return new Asset(code ?? "", issuer);
};

export async function fetchBalance(horizon: string, id: string, claimant: string, nativeCode: string): Promise<BalanceInfo> {
  const server = new Horizon.Server(horizon);
  const cb = await server.claimableBalances().claimableBalance(id.trim()).call();
  const createdAt = Math.floor(Date.parse((cb as unknown as { last_modified_time?: string }).last_modified_time ?? new Date().toISOString()) / 1000);
  const entry = cb.claimants.find((c) => c.destination === claimant);
  if (!entry) throw new Error("This account is not a claimant of the selected balance.");
  const pred = entry.predicate as unknown as HorizonPredicate;
  const w = claimWindow(pred, createdAt, Math.floor(Date.now() / 1000));
  const asset = assetFromString(cb.asset);
  return {
    id: cb.id,
    amount: cb.amount,
    asset,
    assetLabel: asset.isNative() ? nativeCode : `${asset.getCode()}`,
    sponsor: cb.sponsor,
    claimant: entry.destination,
    predicateText: describe(pred),
    ...w,
  };
}

/** List every claimable balance where `claimant` is a claimant. */
export async function fetchClaimableBalances(horizon: string, claimant: string, nativeCode: string): Promise<BalanceInfo[]> {
  const server = new Horizon.Server(horizon);
  let page = await server.claimableBalances().claimant(claimant).limit(200).order("desc").call();
  const balances: BalanceInfo[] = [];
  const seen = new Set<string>();
  const now = Math.floor(Date.now() / 1000);
  while (page.records.length) {
    let added = 0;
    for (const cb of page.records) {
      if (seen.has(cb.id)) continue;
      seen.add(cb.id);
      added++;
      const entry = cb.claimants.find((c) => c.destination === claimant);
      if (!entry) continue;
      const createdAt = Math.floor(Date.parse((cb as unknown as { last_modified_time?: string }).last_modified_time ?? new Date().toISOString()) / 1000);
      const pred = entry.predicate as unknown as HorizonPredicate;
      const asset = assetFromString(cb.asset);
      balances.push({
        id: cb.id, amount: cb.amount, asset,
        assetLabel: asset.isNative() ? nativeCode : asset.getCode(),
        ...(cb.sponsor ? { sponsor: cb.sponsor } : {}),
        claimant: entry.destination, predicateText: describe(pred),
        ...claimWindow(pred, createdAt, now),
      });
    }
    if (!added) break;
    page = await page.next();
  }
  return balances;
}

export async function fetchFeeStats(horizon: string): Promise<FeeStats> {
  const s = await new Horizon.Server(horizon).feeStats();
  return {
    min: Number(s.last_ledger_base_fee),
    p50: Number(s.fee_charged.p50),
    p90: Number(s.fee_charged.p90),
    p99: Number(s.fee_charged.p99),
    capacity: s.ledger_capacity_usage,
  };
}

/** Estimate local-vs-network clock offset (ms) from the latest closed ledger. */
export async function measureLatency(horizon: string) {
  const t0 = performance.now();
  const r = await fetch(`${horizon.replace(/\/$/, "")}/ledgers?order=desc&limit=1`, { cache: "no-store" });
  const rtt = performance.now() - t0;
  const j = await r.json();
  const closedAt = Date.parse(j._embedded.records[0].closed_at);
  return { rtt, lastClose: closedAt, ledger: j._embedded.records[0].sequence as number };
}

type HorizonReceipt = {
  hash?: string; ledger?: number; ledger_attr?: number; successful?: boolean;
  fee_charged?: string | number; result_xdr?: string;
  extras?: { result_xdr?: string; result_codes?: { transaction?: string; operations?: string[] } };
};

export function feeUnits(stroops: string | number | bigint): string {
  const n = BigInt(stroops);
  return `${n / 10_000_000n}.${(n % 10_000_000n).toString().padStart(7, "0")}`;
}

export function decodeReceipt(data: HorizonReceipt) {
  let feePaid = data.fee_charged === undefined ? null : feeUnits(data.fee_charged);
  let code = data.extras?.result_codes?.transaction ?? null;
  const encoded = data.result_xdr ?? data.extras?.result_xdr;
  if (encoded) {
    try {
      const decoded = xdr.TransactionResult.fromXDR(encoded, "base64");
      // Rejection XDR contains a prospective fee, not proof that it was charged.
      if (typeof data.successful === "boolean") feePaid = feeUnits(decoded.feeCharged);
      const result = decoded.result;
      code = result.type.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      if (result.type === "txFeeBumpInnerFailed") {
        code += ` / ${result.innerResultPair.result.result.type.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`;
      }
    } catch { /* Some Horizons omit XDR; never invent a fee. */ }
  }
  const ops = data.extras?.result_codes?.operations?.filter((op) => op !== "op_success");
  if (ops?.length) code = [code, ...ops].filter(Boolean).join(" / ");
  return { feePaid, code };
}

type SubmitResult = { horizon: string; status: number; data: HorizonReceipt } | { horizon: string; status: 0; data: HorizonReceipt };

async function rawSubmit(horizon: string, envelope: string, outer: AbortSignal): Promise<SubmitResult> {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  outer.addEventListener("abort", onAbort, { once: true });
  if (outer.aborted) ctl.abort();
  const timer = setTimeout(() => ctl.abort(), SUBMIT_TIMEOUT_MS);
  try {
    const r = await fetch(`${horizon.replace(/\/$/, "")}/transactions`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `tx=${encodeURIComponent(envelope)}`, signal: ctl.signal, keepalive: true,
    });
    return { horizon, status: r.status, data: await r.json().catch(() => ({})) };
  } catch {
    return { horizon, status: 0, data: {} };
  } finally {
    clearTimeout(timer);
    outer.removeEventListener("abort", onAbort);
  }
}

export class RecoveryEngine {
  private abort = new AbortController();
  private broadcastAbort = new AbortController();
  private servers: Horizon.Server[];
  constructor(private cfg: EngineConfig, private log: Logger) {
    validateEndpoints(cfg.horizons);
    this.servers = cfg.horizons.map((h) => new Horizon.Server(h, { allowHttp: h.startsWith("http://") }));
  }

  stop() { this.abort.abort(); this.broadcastAbort.abort(); }
  private get primary() {
    const server = this.servers[0];
    if (!server) throw new Error("No Horizon endpoint configured.");
    return server;
  }

  private async build(balance: BalanceInfo, unlockAt: number, maxTime: number, perOpFee: number) {
    const { cfg } = this;
    this.abort.signal.throwIfAborted();
    const account = await this.primary.loadAccount(cfg.claimant.publicKey());
    this.abort.signal.throwIfAborted();
    const builder = new TransactionBuilder(account, {
      fee: String(cfg.feeBump ? cfg.baseFee : perOpFee),
      networkPassphrase: cfg.network.passphrase,
      timebounds: { minTime: unlockAt, maxTime },
    }).addOperation(Operation.claimClaimableBalance({ balanceId: balance.id }))
      .addOperation(Operation.payment({ destination: cfg.destination, asset: balance.asset, amount: balance.amount }));
    if (cfg.mergeAccount) builder.addOperation(Operation.accountMerge({ destination: cfg.destination }));
    const inner = builder.build();
    inner.sign(cfg.claimant);
    let tx: Transaction | FeeBumpTransaction = inner;
    if (cfg.feeBump) {
      const payer = cfg.feeSource ?? cfg.claimant;
      tx = TransactionBuilder.buildFeeBumpTransaction(payer, String(perOpFee), inner, cfg.network.passphrase);
      tx.sign(payer);
    }
    const hash = Buffer.from(tx.hash()).toString("hex");
    this.log("info", `Built ${cfg.feeBump ? "fee-bump " : ""}claim_and_send · ${balance.amount} ${balance.assetLabel} · seq=${inner.sequence} · minTime=${unlockAt} · maxTime=${maxTime}`, { hash });
    // Signed envelopes and signing keys are deliberately never logged or persisted.
    return { tx, inner, hash };
  }

  private async latestLedger() {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    this.abort.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), 1000);
    try {
      const r = await fetch(`${this.cfg.horizons[0]?.replace(/\/$/, "")}/ledgers?order=desc&limit=1`, { cache: "no-store", signal: ctl.signal });
      if (!r.ok) throw new Error("Ledger data unavailable");
      const j = await r.json();
      const closeTime = Date.parse(j._embedded?.records?.[0]?.closed_at) / 1000;
      if (!Number.isFinite(closeTime) || Date.now() / 1000 - closeTime > 30) throw new Error("Ledger data stale");
      return closeTime;
    } finally {
      clearTimeout(timer);
      this.abort.signal.removeEventListener("abort", onAbort);
    }
  }

  private async waitForFire(unlockAt: number) {
    const { cfg } = this;
    const fixed = unlockAt * 1000 - cfg.leadMs;
    const start = cfg.timingMode === "ledger" ? unlockAt * 1000 - LEDGER_GATE_START_MS : fixed;
    while (Date.now() < start) await sleep(Math.min(500, start - Date.now()), this.abort.signal);
    if (cfg.timingMode === "ledger") {
      this.log("net", "Ledger gate polling · every 250ms · closeTime + 10s ≥ unlock");
      while (Date.now() < unlockAt * 1000) {
        const tick = Date.now();
        try {
          const closeTime = await this.latestLedger();
          this.log("net", `Ledger gate · closeTime=${new Date(closeTime * 1000).toISOString()}`);
          if (ledgerGateOpen(closeTime, unlockAt)) return;
        } catch {
          this.abort.signal.throwIfAborted();
          this.log("warn", "Ledger data unavailable — falling back to fixed fire lead.");
          break;
        }
        await sleep(Math.max(0, LEDGER_POLL_MS - (Date.now() - tick)), this.abort.signal);
      }
    }
    while (Date.now() < fixed) await sleep(Math.min(20, fixed - Date.now()), this.abort.signal);
  }

  private async lookup(hash: string): Promise<HorizonReceipt | null> {
    const responses = await Promise.all(this.cfg.horizons.map(async (h) => {
      const ctl = new AbortController();
      const onAbort = () => ctl.abort();
      this.broadcastAbort.signal.addEventListener("abort", onAbort, { once: true });
      if (this.broadcastAbort.signal.aborted) ctl.abort();
      const timer = setTimeout(() => ctl.abort(), SUBMIT_TIMEOUT_MS);
      try {
        const r = await fetch(`${h.replace(/\/$/, "")}/transactions/${hash}`, { signal: ctl.signal });
        return r.ok ? await r.json() as HorizonReceipt : null;
      } catch { return null; }
      finally { clearTimeout(timer); this.broadcastAbort.signal.removeEventListener("abort", onAbort); }
    }));
    return responses.find((r) => typeof r?.successful === "boolean") ?? null;
  }

  async run(balance: BalanceInfo): Promise<ExecutionResult> {
    const { cfg, log } = this;
    const signal = this.abort.signal;
    if (balance.claimant !== cfg.claimant.publicKey()) throw new Error("Target belongs to a different claimant.");
    if (balance.unlockAt === null) throw new Error("No claimable window exists for this predicate.");
    const unlockAt = balance.unlockAt;
    const maxTime = Math.min(unlockAt + cfg.windowSec, balance.expiresAt ?? Infinity);
    const deadline = maxTime * 1000;
    if (Date.now() >= deadline) throw new Error("The selected claim window has expired.");
    log("info", `Preflight · ${cfg.horizons.length} endpoint(s) · claimant ${cfg.claimant.publicKey().slice(0, 8)}…`);
    const dest = cfg.destination.startsWith("G") ? cfg.destination : null;
    if (dest) {
      try {
        const account = await this.primary.loadAccount(dest);
        if (!balance.asset.isNative() && !account.balances.some((b) => "asset_code" in b && b.asset_code === balance.asset.getCode() && b.asset_issuer === balance.asset.getIssuer())) {
          throw new Error("Destination has no trustline for this asset (op_no_trust).");
        }
      } catch (e) {
        throw new Error(e instanceof Error && e.message.includes("op_no_trust") ? e.message : "Destination account could not be verified on-chain.");
      }
    }
    // Dry-run builds immediately: no wait and, critically, no broadcast.
    if (cfg.dryRun) {
      const built = await this.build(balance, unlockAt, maxTime, cfg.perOpFee);
      log("ok", `DRY RUN · locally signed · ${cfg.horizons.length} endpoints · interval ${cfg.burstIntervalMs}ms · ${cfg.timingMode} timing · NO submission`, { hash: built.hash });
      return { result: "dry_run", hash: built.hash, ledger: null, feePaid: null, code: null, amount: balance.amount, assetLabel: balance.assetLabel };
    }
    // Warm the connections ahead of the timing gate. Sign with fresh sequence at fire time.
    const warmAt = unlockAt * 1000 - Math.max(LEDGER_GATE_START_MS, cfg.leadMs);
    while (Date.now() < warmAt) await sleep(Math.min(1000, warmAt - Date.now()), signal);
    void prewarm(cfg.horizons);
    await this.waitForFire(unlockAt);
    signal.throwIfAborted();
    let built = await this.build(balance, unlockAt, maxTime, cfg.perOpFee);
    log("warn", `FIRING · T${((Date.now() - unlockAt * 1000) / 1000).toFixed(2)}s · ${cfg.horizons.length} endpoints`);
    let outcome: ExecutionResult | null = null;
    let attempt = 0;
    let ambiguous = false;
    let perOpFee = cfg.perOpFee;
    let escalating = false;
    let lastEscalation = 0;
    const hashes = new Set([built.hash]);
    const pending = new Set<Promise<void>>();
    const finish = (data: HorizonReceipt, fallbackHash: string, failedCode?: string) => {
      if (outcome) return;
      const decoded = decodeReceipt(data);
      const success = data.successful === true && !failedCode;
      const hash = data.hash ?? fallbackHash;
      const ledger = data.ledger ?? data.ledger_attr ?? null;
      outcome = { result: success ? "successful" : "failed", hash, ledger, feePaid: decoded.feePaid, code: failedCode ?? decoded.code, amount: balance.amount, assetLabel: balance.assetLabel };
      log(success ? "ok" : "error", success
        ? `SUCCESSFUL · ledger ${ledger ?? "awaiting receipt"} · swept ${balance.amount} ${balance.assetLabel} · fee ${decoded.feePaid ?? "unavailable"} ${cfg.network.nativeCode}`
        : `FAILED · ${outcome.code ?? "tx_failed"} · ledger ${ledger ?? "unavailable"} · fee ${decoded.feePaid ?? "unavailable"}`, { hash });
    };
    const escalateFee = async () => {
      if (!cfg.escalate || escalating || outcome || Date.now() - lastEscalation < 1500) return;
      const next = Math.min(perOpFee * (cfg.feeBump ? 10 : 2), cfg.maxPerOpFee);
      if (next <= perOpFee) return;
      escalating = true;
      lastEscalation = Date.now();
      try {
        // Rewrap the SAME signed inner envelope; never change its sequence while pending.
        if (cfg.feeBump) {
          const payer = cfg.feeSource ?? cfg.claimant;
          const tx = TransactionBuilder.buildFeeBumpTransaction(payer, String(next), built.inner, cfg.network.passphrase);
          tx.sign(payer);
          built = { ...built, tx, hash: Buffer.from(tx.hash()).toString("hex") };
        } else built = await this.build(balance, unlockAt, maxTime, next);
        hashes.add(built.hash);
        perOpFee = next;
        log("warn", `Fee escalated · ${perOpFee} stroops/op`, { hash: built.hash });
      } finally { escalating = false; }
    };
    const broadcast = async (number: number, envelope: string, hash: string) => {
      await Promise.all(cfg.horizons.map(async (h) => {
        const r = await rawSubmit(h, envelope, this.broadcastAbort.signal);
        if (outcome || signal.aborted) return;
        const code = r.data.extras?.result_codes?.transaction;
        log(r.data.successful === true ? "ok" : code === "tx_too_early" ? "info" : "net", `#${number} · ${h} · ${code ?? (r.status ? `HTTP ${r.status}` : "timeout/network error")}`, { hash });
        if (r.data.successful === true || r.data.successful === false) {
          // A POST success must explicitly report successful; fee derives from actual receipt XDR.
          let receipt = r.data;
          if (decodeReceipt(receipt).feePaid === null) receipt = await this.lookup(hash) ?? receipt;
          finish(receipt, hash);
        } else if (code === "tx_failed" || code === "tx_fee_bump_inner_failed") {
          const receipt = await this.lookup(hash);
          const decoded = decodeReceipt(r.data);
          if (!receipt && decoded.code?.includes("tx_too_early")) {
            log("info", `#${number} · fee-bump inner tx_too_early rejected before inclusion — retrying`, { hash });
            return;
          }
          if (!receipt && decoded.code?.includes("tx_bad_seq")) { ambiguous = true; return; }
          finish(receipt ?? r.data, hash, decodeReceipt(r.data).code ?? code);
        } else if (code === "tx_insufficient_fee") {
          await escalateFee();
          if (perOpFee >= cfg.maxPerOpFee && !escalating) log("warn", "Fee cap reached; continuing at cap until window closes.");
        } else if (code && !["tx_too_early", "tx_bad_seq", "tx_duplicate", "duplicate"].includes(code)) {
          finish(r.data, hash, decodeReceipt(r.data).code ?? code);
        } else if (code !== "tx_too_early") {
          ambiguous = true;
        }
      }));
    };
    const poll = async () => {
      for (const hash of hashes) {
        if (outcome || signal.aborted) return;
        const receipt = await this.lookup(hash);
        if (receipt) finish(receipt, hash);
      }
    };
    let nextPoll = 0;
    try {
      while (Date.now() < deadline && !outcome) {
        signal.throwIfAborted();
        const tick = Date.now();
        attempt++;
        log("net", `Attempt #${attempt} · broadcasting to ${cfg.horizons.length} endpoint(s)`, { hash: built.hash });
        const task = broadcast(attempt, built.tx.toXDR(), built.hash).catch(() => { ambiguous = true; }).finally(() => pending.delete(task));
        pending.add(task);
        if (tick >= nextPoll) {
          nextPoll = tick + 1000;
          const task = poll().finally(() => pending.delete(task));
          pending.add(task);
        }
        // Do not wait for slow HTTP responses: cadence is independent of response time.
        await sleep(Math.max(0, cfg.burstIntervalMs - (Date.now() - tick)), signal);
      }
      if (!outcome) {
        log("warn", "Execution window closed; reconciling outstanding submissions.");
        await Promise.allSettled([...pending]);
        await poll();
      }
      const final: ExecutionResult = outcome ?? { result: ambiguous ? "unconfirmed" : "failed", hash: built.hash, ledger: null, feePaid: null, code: ambiguous ? "inclusion_unconfirmed" : "execution_window_closed", amount: balance.amount, assetLabel: balance.assetLabel };
      if (!outcome) log("error", `${final.result === "unconfirmed" ? "UNCONFIRMED — verify explorer; a pending submission may still land" : "FAILED — execution window closed without inclusion"}`, { hash: built.hash });
      return final;
    } finally {
      this.broadcastAbort.abort();
    }
  }
}
