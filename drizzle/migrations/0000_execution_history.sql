CREATE TABLE public.execution_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL,
 network_id text NOT NULL,
 balance_id text NOT NULL,
 amount text NOT NULL,
 asset_label text NOT NULL,
 unlock_time timestamptz,
 result text NOT NULL CHECK (result IN ('scheduled','submitting','successful','failed','dry_run','cancelled','unconfirmed')),
 tx_hash text,
 ledger bigint,
 fee_paid text,
 result_code text,
 dry_run boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.execution_history TO authenticated;
GRANT ALL ON public.execution_history TO service_role;
ALTER TABLE public.execution_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY history_read_own ON public.execution_history FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY history_insert_own ON public.execution_history FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY history_update_own ON public.execution_history FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX history_owner_time ON public.execution_history (user_id, created_at DESC);