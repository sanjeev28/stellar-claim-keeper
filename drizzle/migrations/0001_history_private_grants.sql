REVOKE ALL ON public.execution_history FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.execution_history TO authenticated;
GRANT ALL ON public.execution_history TO service_role;