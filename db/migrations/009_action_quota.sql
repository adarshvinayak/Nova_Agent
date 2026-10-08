BEGIN;
ALTER TABLE public.va_sessions DROP CONSTRAINT va_sessions_state_check;
ALTER TABLE public.va_sessions ADD CONSTRAINT va_sessions_state_check CHECK(state IN ('captured','clarifying','ready','confirming','booked','note_saved','booking_unknown','failed','note_ready','task_ready','task_saved','cancelled','completed','action_expired'));
ALTER TABLE public.va_speech_sessions ADD COLUMN action_session_id uuid;
ALTER TABLE public.va_speech_sessions ADD CONSTRAINT va_speech_action_session FOREIGN KEY(workspace_id,worker_id,action_session_id) REFERENCES public.va_sessions(workspace_id,worker_id,id);
CREATE TABLE private.va_action_quotas (
 workspace_id uuid NOT NULL,worker_id uuid PRIMARY KEY,generation integer NOT NULL DEFAULT 1 CHECK(generation>0),
 used integer NOT NULL DEFAULT 0 CHECK(used BETWEEN 0 AND 3),reset_at timestamptz,
 FOREIGN KEY(workspace_id,worker_id) REFERENCES public.va_workers(workspace_id,id),UNIQUE(workspace_id,worker_id)
);
CREATE TABLE private.va_actions (
 session_id uuid PRIMARY KEY,workspace_id uuid NOT NULL,worker_id uuid NOT NULL,generation integer NOT NULL CHECK(generation>0),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','cancelled','expired','reset')),
 started_at timestamptz NOT NULL DEFAULT now(),last_user_activity_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 completion_reason text CHECK(completion_reason IN ('confirmed','completed','cancelled','idle_timeout','admin_reset')),
 FOREIGN KEY(workspace_id,worker_id,session_id) REFERENCES public.va_sessions(workspace_id,worker_id,id),
 CHECK((status='active' AND completed_at IS NULL AND completion_reason IS NULL) OR(status<>'active' AND completed_at IS NOT NULL AND completion_reason IS NOT NULL))
);
CREATE INDEX va_actions_active ON private.va_actions(worker_id,generation,last_user_activity_at) WHERE status='active';
ALTER TABLE private.va_action_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.va_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.va_action_quotas,private.va_actions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON private.va_action_quotas,private.va_actions TO service_role;
COMMIT;
