BEGIN;
CREATE TABLE private.va_external_connectors (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES public.va_workspaces(id),
 provider text NOT NULL CHECK(provider IN ('google','outlook','icloud','fastmail')),
 status text NOT NULL CHECK(status IN ('connected','disabled')),
 credentials_ciphertext text NOT NULL, calendars jsonb NOT NULL DEFAULT '[]',
 calendar_id text, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,provider)
);
CREATE TABLE private.va_connector_states (
 state_hash text PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES public.va_workspaces(id),
 worker_id uuid NOT NULL REFERENCES public.va_workers(id), actor_alias text NOT NULL,
 connector_id uuid NOT NULL, provider text NOT NULL CHECK(provider IN ('google','outlook')),
 credentials_ciphertext text NOT NULL, expires_at timestamptz NOT NULL,
 consumed_at timestamptz
);
ALTER TABLE private.va_external_connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.va_connector_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.va_external_connectors,private.va_connector_states FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON private.va_external_connectors,private.va_connector_states TO service_role;
COMMIT;
