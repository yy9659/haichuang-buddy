ALTER TABLE users ADD COLUMN role text NOT NULL DEFAULT 'merchant' CHECK (role IN ('merchant', 'admin'));
--> statement-breakpoint
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
--> statement-breakpoint
CREATE TABLE account_invites (
  token_hash text PRIMARY KEY,
  email text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
--> statement-breakpoint
CREATE INDEX account_invites_expiry_idx ON account_invites(expires_at);
--> statement-breakpoint
CREATE TABLE password_resets (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
--> statement-breakpoint
CREATE INDEX password_resets_user_idx ON password_resets(user_id);
--> statement-breakpoint
CREATE INDEX password_resets_expiry_idx ON password_resets(expires_at);
--> statement-breakpoint
CREATE TABLE security_role_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  old_role text NOT NULL,
  new_role text NOT NULL,
  operator text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE security_rate_windows (
  bucket text NOT NULL,
  window_start bigint NOT NULL,
  hits integer NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(bucket, window_start)
);
--> statement-breakpoint
CREATE INDEX security_rate_expiry_idx ON security_rate_windows(expires_at);
--> statement-breakpoint
CREATE TABLE ai_daily_usage (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  day text NOT NULL,
  calls integer NOT NULL,
  PRIMARY KEY(business_id, day)
);
--> statement-breakpoint
CREATE TABLE ai_call_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX ai_lease_business_expiry_idx ON ai_call_leases(business_id, expires_at);
--> statement-breakpoint
CREATE INDEX ai_lease_expiry_idx ON ai_call_leases(expires_at);
--> statement-breakpoint
ALTER TABLE agent_tasks ADD COLUMN business_id uuid REFERENCES businesses(id) ON DELETE CASCADE;
--> statement-breakpoint
UPDATE agent_tasks t
SET business_id = owner.business_id
FROM (
  SELECT a.id, coalesce(w.business_id,p.business_id) AS business_id
  FROM agent_tasks a
  LEFT JOIN agent_workflows w ON w.id=a.workflow_id
  LEFT JOIN products p ON p.id=a.product_id
  WHERE w.business_id IS NULL OR p.business_id IS NULL OR w.business_id=p.business_id
) owner WHERE owner.id=t.id AND owner.business_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX agent_tasks_business_id_idx ON agent_tasks(business_id);
--> statement-breakpoint
-- These tables are only accessed by the trusted server DB role (owner or BYPASSRLS).
-- No anon/authenticated PostgREST policies. Also revoke their explicit/default grants.
DO $$
DECLARE t text; r text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'businesses','users','sessions','owner_profiles','products','product_dna','brand_profiles',
    'contents','agent_tasks','agent_workflows','knowledge_documents','knowledge_chunks',
    'knowledge_gaps','customer_conversations','customer_messages','live_sessions','live_comments',
    'live_suggestions','business_reports','sales_records','public_knowledge_documents',
    'account_invites','password_resets','security_role_audit','security_rate_windows','ai_daily_usage','ai_call_leases'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;
--> statement-breakpoint
-- Preserve object keys; the application now serves these through a tenant-checked endpoint.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    EXECUTE 'UPDATE storage.buckets SET public = false WHERE id = ''product-images'' AND public';
  END IF;
END $$;
