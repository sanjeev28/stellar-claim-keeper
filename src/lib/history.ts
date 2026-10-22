import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import type { ExecutionResult } from "@/lib/stellar/execution";

export type HistoryRow = Database["public"]["Tables"]["execution_history"]["Row"];
export type RunDetails = { networkId: string; balanceId: string; amount: string; assetLabel: string; unlockAt: number | null; dryRun: boolean };
export type HistoryPayload = Omit<Database["public"]["Tables"]["execution_history"]["Insert"], "user_id">;

// Explicit whitelist: neither credentials nor signed envelopes can enter history payloads.
export function historyPayload(run: RunDetails, outcome: ExecutionResult | null): HistoryPayload {
  return {
    network_id: run.networkId, balance_id: run.balanceId, amount: run.amount,
    asset_label: run.assetLabel, unlock_time: run.unlockAt === null ? null : new Date(run.unlockAt * 1000).toISOString(),
    dry_run: run.dryRun, result: outcome?.result ?? "scheduled", tx_hash: outcome?.hash ?? null,
    ledger: outcome?.ledger ?? null, fee_paid: outcome?.feePaid ?? null, result_code: outcome?.code ?? null,
  };
}

export function useExecutionHistory() {
  const [userId, setUserId] = useState<string | null>(null);
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const owner = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const uid = owner.current;
    if (!uid) return;
    setLoading(true);
    const { data, error } = await supabase.from("execution_history").select("*").eq("user_id", uid).order("created_at", { ascending: false });
    if (owner.current === uid) {
      setRows(data ?? []);
      setError(error ? "History could not be loaded. Try refreshing." : null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getUser().then(({ data }) => {
      if (!mounted) return;
      owner.current = data.user?.id ?? null;
      setUserId(owner.current);
      if (owner.current) void refresh();
    });
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (!["SIGNED_IN", "SIGNED_OUT", "USER_UPDATED"].includes(event)) return;
      owner.current = session?.user.id ?? null;
      setUserId(owner.current);
      setRows([]);
      if (owner.current) setTimeout(() => { void refresh(); }, 0);
    });
    return () => { mounted = false; data.subscription.unsubscribe(); };
  }, [refresh]);

  const save = useCallback(async (payload: HistoryPayload) => {
    const uid = owner.current;
    if (!uid) { setError("This run is not saved. Sign in before arming to save private history."); return null; }
    const { data, error } = await supabase.from("execution_history").insert({ ...payload, user_id: uid }).select("id").single().then((r) => r, () => ({ data: null, error: true }));
    if (error || !data) { setError("Run could not be saved to history. Execution is unaffected."); return null; }
    void refresh();
    return data.id;
  }, [refresh]);

  const update = useCallback(async (id: string, payload: Partial<HistoryPayload>) => {
    const { error } = await supabase.from("execution_history").update(payload).eq("id", id);
    if (error) setError("History update failed. Check the execution console for the outcome.");
    void refresh();
  }, [refresh]);

  return { userId, rows, error, loading, refresh, save, update };
}