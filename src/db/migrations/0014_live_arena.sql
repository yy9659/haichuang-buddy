CREATE TABLE live_arenas (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  state jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX live_arenas_one_active_idx ON live_arenas(business_id) WHERE active;
--> statement-breakpoint
CREATE INDEX live_arenas_history_idx ON live_arenas(business_id, updated_at DESC);
--> statement-breakpoint
ALTER TABLE live_arenas ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE live_arenas FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON public.live_arenas FROM %I', r);
    END IF;
  END LOOP;
END $$;
