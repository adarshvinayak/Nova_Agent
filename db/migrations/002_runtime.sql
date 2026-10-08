BEGIN;
ALTER TABLE public.va_sessions ADD COLUMN processing_token uuid;
ALTER TABLE public.va_sessions ADD COLUMN processing_until timestamptz;
CREATE TABLE private.va_demo_events (
 calendar_id text NOT NULL,event_id text NOT NULL,snapshot jsonb NOT NULL,intent_hash text NOT NULL,
 status text NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','cancelled')),
 PRIMARY KEY(calendar_id,event_id)
);
CREATE TABLE private.va_oauth_states (
 state_hash text PRIMARY KEY,workspace_id uuid NOT NULL REFERENCES public.va_workspaces(id),
 verifier_ciphertext text NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz
);
ALTER TABLE private.va_demo_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.va_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.va_demo_events,private.va_oauth_states FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON private.va_demo_events,private.va_oauth_states TO service_role;
COMMIT;
