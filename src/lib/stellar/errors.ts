const TX: Record<string, string> = {
  tx_too_early: "Ledger close time is before the tx minTime — unlock not reached yet (no fee charged).",
  tx_too_late: "Transaction maxTime passed. Rebuild with a new time window.",
  tx_bad_seq: "Sequence number mismatch — another tx from this account landed first. Reload account.",
  tx_insufficient_fee: "Fee bid below the current surge price. Raise the priority fee.",
  tx_insufficient_balance: "Source cannot cover fee + reserves.",
  tx_bad_auth: "Signature invalid / wrong network passphrase / key not a signer.",
  tx_bad_auth_extra: "Unused signatures attached.",
  tx_no_source_account: "Source account does not exist on this network.",
  tx_failed: "One or more operations failed (see op codes). Fee was charged.",
  tx_internal_error: "Core internal error — retry.",
  tx_fee_bump_inner_failed: "Fee bump accepted but inner transaction failed.",
  tx_missing_operation: "No operations in transaction.",
};
const OP: Record<string, string> = {
  op_does_not_exist: "Claimable balance not found — already claimed or wrong ID.",
  op_cannot_claim: "Predicate not satisfied for this claimant (too early / expired / not a claimant).",
  op_line_full: "Claimant trustline limit would be exceeded.",
  op_no_trust: "Missing trustline for the asset (claimant or destination).",
  op_not_authorized: "Asset issuer has not authorized the trustline.",
  op_underfunded: "Not enough balance to send the payment.",
  op_no_destination: "Destination account does not exist (native payment needs ≥ base reserve via create_account).",
  op_src_no_trust: "Source has no trustline for this asset.",
  op_malformed: "Operation malformed — check amount and addresses.",
  op_has_sub_entries: "Account merge blocked: account has trustlines/offers/data entries.",
};

export type Diagnosis = { title: string; details: string[] };

export function diagnose(err: unknown): Diagnosis {
  const e = err as {
    response?: { status?: number; data?: { title?: string; extras?: { result_codes?: { transaction?: string; operations?: string[] } } } };
    message?: string;
  };
  const data = e?.response?.data;
  const codes = data?.extras?.result_codes;
  if (codes) {
    const details: string[] = [];
    if (codes.transaction) details.push(`${codes.transaction}: ${TX[codes.transaction] ?? "unknown"}`);
    codes.operations?.forEach((op, i) => {
      if (op !== "op_success") details.push(`op[${i}] ${op}: ${OP[op] ?? "unknown"}`);
    });
    return { title: codes.transaction ?? "rejected", details };
  }
  if (e?.response?.status === 504) return { title: "timeout", details: ["Horizon 504 — tx may still be pending; polling by hash."] };
  return { title: data?.title ?? "error", details: [e?.message ?? String(err)] };
}

export const txCode = (err: unknown) =>
  (err as { response?: { data?: { extras?: { result_codes?: { transaction?: string } } } } })?.response?.data?.extras
    ?.result_codes?.transaction;
