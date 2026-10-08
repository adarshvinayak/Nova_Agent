BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;

CREATE TABLE public.va_workspaces (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
 time_zone text NOT NULL DEFAULT 'Asia/Dubai', config_version integer NOT NULL DEFAULT 1 CHECK(config_version>0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.va_workers (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES public.va_workspaces(id),
 email text NOT NULL, display_name text NOT NULL, active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,id), UNIQUE(workspace_id,email)
);
CREATE TABLE private.va_calendar_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.va_workspaces(id),
 calendar_id text NOT NULL, calendar_label text NOT NULL,
 provider text NOT NULL DEFAULT 'google' CHECK(provider IN ('google','simulated')),
 status text NOT NULL DEFAULT 'connected' CHECK(status IN ('connected','reconnect_required','disabled')),
 scopes text[] NOT NULL DEFAULT '{}', access_token_ciphertext text, refresh_token_ciphertext text,
 token_key_version integer, access_expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,calendar_id)
);
CREATE UNIQUE INDEX va_one_active_calendar ON private.va_calendar_connections(workspace_id) WHERE status <> 'disabled';
CREATE TABLE public.va_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, worker_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'captured' CHECK(state IN ('captured','clarifying','ready','confirming','booked','note_saved','booking_unknown','failed')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), facts jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(facts)='object'),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), content_redacted_at timestamptz,
 UNIQUE(workspace_id,worker_id,id), FOREIGN KEY(workspace_id,worker_id) REFERENCES public.va_workers(workspace_id,id)
);
CREATE TABLE public.va_turns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, worker_id uuid NOT NULL, session_id uuid NOT NULL,
 turn_no integer NOT NULL CHECK(turn_no>0), speaker text NOT NULL CHECK(speaker IN ('user','assistant')),
 body text CHECK(body IS NULL OR length(body)<=8000), source text CHECK(source IN ('typed','browser_voice','shortcut_dictation','share_text')),
 client_turn_id text, created_at timestamptz NOT NULL DEFAULT now(), content_redacted_at timestamptz,
 UNIQUE(session_id,turn_no), UNIQUE(worker_id,client_turn_id),
 FOREIGN KEY(workspace_id,worker_id,session_id) REFERENCES public.va_sessions(workspace_id,worker_id,id)
);
CREATE TABLE public.va_proposals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, worker_id uuid NOT NULL, session_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0), session_version integer NOT NULL CHECK(session_version>0), config_version integer NOT NULL CHECK(config_version>0),
 calendar_id text NOT NULL, snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 snapshot_hash text NOT NULL CHECK(snapshot_hash ~ '^[0-9a-f]{64}$'), starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 time_zone text NOT NULL DEFAULT 'Asia/Dubai', checked_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','consumed','superseded','expired','blocked')),
 created_at timestamptz NOT NULL DEFAULT now(), content_redacted_at timestamptz,
 UNIQUE(session_id,version), UNIQUE(workspace_id,worker_id,session_id,id),
 FOREIGN KEY(workspace_id,worker_id,session_id) REFERENCES public.va_sessions(workspace_id,worker_id,id),
 CHECK(ends_at>starts_at), CHECK(expires_at>created_at)
);
CREATE UNIQUE INDEX va_one_ready_proposal ON public.va_proposals(session_id) WHERE status='ready';
CREATE TABLE public.va_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, worker_id uuid NOT NULL, session_id uuid NOT NULL,
 proposal_id uuid NOT NULL UNIQUE, idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 intent_hash text NOT NULL CHECK(intent_hash ~ '^[0-9a-f]{64}$'), calendar_id text NOT NULL,
 event_id text NOT NULL CHECK(event_id ~ '^vc[0-9a-f]{32}$'), starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 time_zone text NOT NULL DEFAULT 'Asia/Dubai', status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','writing','unknown','succeeded','blocked','failed')),
 confirmed_at timestamptz NOT NULL DEFAULT now(), dispatch_at timestamptz, resolved_at timestamptz,
 recovery_token uuid, recovery_generation integer NOT NULL DEFAULT 0 CHECK(recovery_generation>=0), recovery_lease_until timestamptz,
 error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(worker_id,idempotency_key), UNIQUE(calendar_id,event_id), UNIQUE(workspace_id,worker_id,session_id,id),
 FOREIGN KEY(workspace_id,worker_id,session_id,proposal_id) REFERENCES public.va_proposals(workspace_id,worker_id,session_id,id),
 CHECK(ends_at>starts_at), CHECK(status NOT IN ('writing','unknown','succeeded') OR dispatch_at IS NOT NULL),
 CHECK(status NOT IN ('succeeded','blocked','failed') OR resolved_at IS NOT NULL),
 CHECK((recovery_token IS NULL)=(recovery_lease_until IS NULL)),
 CONSTRAINT va_no_overlapping_booking EXCLUDE USING gist(calendar_id WITH =,tstzrange(starts_at,ends_at,'[)') WITH &&)
 WHERE(status IN ('reserved','writing','unknown','succeeded'))
);
CREATE UNIQUE INDEX va_one_active_attempt ON public.va_attempts(session_id) WHERE status IN ('reserved','writing','unknown','succeeded');
CREATE TABLE public.va_records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, worker_id uuid NOT NULL, session_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('event','note')), title text, body text, location text,
 starts_at timestamptz, ends_at timestamptz, time_zone text, booking_attempt_id uuid UNIQUE,
 outcome text NOT NULL CHECK(outcome IN ('booked','saved')), created_at timestamptz NOT NULL DEFAULT now(), content_redacted_at timestamptz,
 FOREIGN KEY(workspace_id,worker_id,session_id) REFERENCES public.va_sessions(workspace_id,worker_id,id),
 FOREIGN KEY(workspace_id,worker_id,session_id,booking_attempt_id) REFERENCES public.va_attempts(workspace_id,worker_id,session_id,id),
 CHECK((kind='event' AND outcome='booked' AND booking_attempt_id IS NOT NULL AND starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at>starts_at AND time_zone IS NOT NULL)
 OR(kind='note' AND outcome='saved' AND booking_attempt_id IS NULL AND starts_at IS NULL AND ends_at IS NULL AND time_zone IS NULL))
);
CREATE UNIQUE INDEX va_one_note ON public.va_records(session_id) WHERE kind='note';
CREATE TABLE public.va_speech_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, worker_id uuid NOT NULL,
 provider text NOT NULL CHECK(provider IN ('deepgram','simulated')), status text NOT NULL DEFAULT 'issued' CHECK(status IN ('issued','streaming','finished','failed','abandoned')),
 provider_request_id text, started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
 audio_seconds numeric(14,3) CHECK(audio_seconds>=0), UNIQUE(workspace_id,worker_id,id),
 FOREIGN KEY(workspace_id,worker_id) REFERENCES public.va_workers(workspace_id,id)
);
CREATE TABLE public.va_usage_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, worker_id uuid NOT NULL, session_id uuid, speech_session_id uuid,
 provider text NOT NULL, provider_request_id text NOT NULL, operation text NOT NULL,
 audio_seconds numeric(14,3) CHECK(audio_seconds>=0), input_tokens bigint CHECK(input_tokens>=0), output_tokens bigint CHECK(output_tokens>=0),
 rate_version text, estimated_cost_aed numeric(14,6) CHECK(estimated_cost_aed>=0),
 cost_status text NOT NULL DEFAULT 'unknown' CHECK(cost_status IN ('estimated','unknown','not_applicable')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(provider,provider_request_id,operation),
 FOREIGN KEY(workspace_id,worker_id) REFERENCES public.va_workers(workspace_id,id),
 FOREIGN KEY(workspace_id,worker_id,session_id) REFERENCES public.va_sessions(workspace_id,worker_id,id),
 FOREIGN KEY(workspace_id,worker_id,speech_session_id) REFERENCES public.va_speech_sessions(workspace_id,worker_id,id),
 CHECK((cost_status='unknown' AND estimated_cost_aed IS NULL) OR(cost_status='estimated' AND estimated_cost_aed IS NOT NULL AND rate_version IS NOT NULL)
 OR(cost_status='not_applicable' AND estimated_cost_aed=0))
);
CREATE TABLE public.va_idempotency (
 workspace_id uuid NOT NULL, worker_id uuid NOT NULL, operation text NOT NULL,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128), payload_hash text NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
 status text NOT NULL DEFAULT 'processing' CHECK(status IN ('processing','completed','failed')), response jsonb, resource_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(worker_id,operation,idempotency_key), FOREIGN KEY(workspace_id,worker_id) REFERENCES public.va_workers(workspace_id,id)
);
CREATE TABLE private.va_credentials (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, worker_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('shortcut','handoff','owner_setup')), token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 session_id uuid, expires_at timestamptz NOT NULL, consumed_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,worker_id) REFERENCES public.va_workers(workspace_id,id),
 FOREIGN KEY(workspace_id,worker_id,session_id) REFERENCES public.va_sessions(workspace_id,worker_id,id), CHECK(expires_at>created_at)
);
CREATE TABLE private.va_rate_limits (
 bucket_hash text NOT NULL, window_start timestamptz NOT NULL, request_count integer NOT NULL CHECK(request_count>=0),
 expires_at timestamptz NOT NULL, PRIMARY KEY(bucket_hash,window_start)
);
CREATE TABLE private.va_operation_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid REFERENCES public.va_workspaces(id), actor_worker_id uuid REFERENCES public.va_workers(id),
 subject_id uuid, event_type text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX va_sessions_owner ON public.va_sessions(worker_id,created_at DESC,id DESC);
CREATE INDEX va_records_owner ON public.va_records(worker_id,created_at DESC,id DESC);
CREATE INDEX va_turns_session ON public.va_turns(session_id,turn_no);
CREATE INDEX va_attempts_recovery ON public.va_attempts(status,dispatch_at);
CREATE INDEX va_proposals_expiry ON public.va_proposals(expires_at) WHERE status='ready';
CREATE INDEX va_idempotency_created ON public.va_idempotency(created_at);
CREATE INDEX va_usage_owner ON public.va_usage_events(worker_id,created_at);

CREATE FUNCTION private.va_protect_proposal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,private AS $$
BEGIN
 IF ROW(NEW.id,NEW.workspace_id,NEW.worker_id,NEW.session_id,NEW.version,NEW.session_version,NEW.config_version,NEW.calendar_id,NEW.snapshot_hash,NEW.starts_at,NEW.ends_at,NEW.time_zone,NEW.checked_at,NEW.expires_at,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.worker_id,OLD.session_id,OLD.version,OLD.session_version,OLD.config_version,OLD.calendar_id,OLD.snapshot_hash,OLD.starts_at,OLD.ends_at,OLD.time_zone,OLD.checked_at,OLD.expires_at,OLD.created_at) THEN
 RAISE EXCEPTION 'proposal identity is immutable'; END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status<>'ready' THEN RAISE EXCEPTION 'terminal proposal status is immutable'; END IF;
 IF NEW.snapshot IS DISTINCT FROM OLD.snapshot AND (NEW.snapshot<>'{}'::jsonb OR NEW.content_redacted_at IS NULL OR NEW.status='ready'
 OR EXISTS(SELECT 1 FROM public.va_attempts WHERE proposal_id=OLD.id AND status IN ('reserved','writing','unknown'))) THEN
 RAISE EXCEPTION 'proposal snapshot is immutable except safe terminal redaction'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER va_proposal_guard BEFORE UPDATE ON public.va_proposals FOR EACH ROW EXECUTE FUNCTION private.va_protect_proposal();

CREATE FUNCTION private.va_protect_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,private AS $$
DECLARE p public.va_proposals%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.id,NEW.workspace_id,NEW.worker_id,NEW.session_id,NEW.proposal_id,NEW.idempotency_key,NEW.intent_hash,NEW.calendar_id,NEW.event_id,NEW.starts_at,NEW.ends_at,NEW.time_zone,NEW.confirmed_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.worker_id,OLD.session_id,OLD.proposal_id,OLD.idempotency_key,OLD.intent_hash,OLD.calendar_id,OLD.event_id,OLD.starts_at,OLD.ends_at,OLD.time_zone,OLD.confirmed_at) THEN RAISE EXCEPTION 'attempt identity is immutable'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT(
   (OLD.status='reserved' AND NEW.status IN ('writing','blocked','failed')) OR
   (OLD.status='writing' AND NEW.status IN ('unknown','succeeded','failed')) OR
   (OLD.status='unknown' AND NEW.status IN ('succeeded','failed'))
  ) THEN RAISE EXCEPTION 'invalid booking transition: % to %',OLD.status,NEW.status; END IF;
  IF NEW.recovery_generation<OLD.recovery_generation OR NEW.recovery_generation>OLD.recovery_generation+1 THEN RAISE EXCEPTION 'invalid recovery generation'; END IF;
  IF NEW.recovery_token IS DISTINCT FROM OLD.recovery_token AND NEW.recovery_token IS NOT NULL AND NEW.recovery_generation<>OLD.recovery_generation+1 THEN RAISE EXCEPTION 'new recovery lease requires new generation'; END IF;
  IF OLD.dispatch_at IS NOT NULL AND NEW.dispatch_at IS DISTINCT FROM OLD.dispatch_at THEN RAISE EXCEPTION 'original dispatch timestamp is immutable'; END IF;
 ELSE
  IF NEW.status<>'reserved' OR NEW.dispatch_at IS NOT NULL THEN RAISE EXCEPTION 'attempt starts reserved'; END IF;
 END IF;
 SELECT * INTO STRICT p FROM public.va_proposals WHERE id=NEW.proposal_id;
 IF ROW(NEW.calendar_id,NEW.intent_hash,NEW.starts_at,NEW.ends_at,NEW.time_zone) IS DISTINCT FROM ROW(p.calendar_id,p.snapshot_hash,p.starts_at,p.ends_at,p.time_zone) THEN RAISE EXCEPTION 'attempt must match proposal'; END IF;
 IF NEW.event_id<>'vc'||replace(NEW.id::text,'-','') THEN RAISE EXCEPTION 'event ID must derive from attempt ID'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER va_attempt_guard BEFORE INSERT OR UPDATE ON public.va_attempts FOR EACH ROW EXECUTE FUNCTION private.va_protect_attempt();

CREATE FUNCTION private.va_validate_record() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,private AS $$
DECLARE a public.va_attempts%ROWTYPE;
BEGIN
 IF NEW.kind='event' THEN
 SELECT * INTO STRICT a FROM public.va_attempts WHERE id=NEW.booking_attempt_id;
 IF a.status<>'succeeded' OR ROW(NEW.starts_at,NEW.ends_at,NEW.time_zone) IS DISTINCT FROM ROW(a.starts_at,a.ends_at,a.time_zone) THEN RAISE EXCEPTION 'record requires succeeded matching attempt'; END IF;
 ELSE
 IF EXISTS(SELECT 1 FROM public.va_attempts WHERE session_id=NEW.session_id AND status IN ('reserved','writing','unknown','succeeded')) THEN RAISE EXCEPTION 'cannot save note for active booking'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER va_record_guard BEFORE INSERT OR UPDATE ON public.va_records FOR EACH ROW EXECUTE FUNCTION private.va_validate_record();
REVOKE ALL ON FUNCTION private.va_protect_proposal(),private.va_protect_attempt(),private.va_validate_record() FROM PUBLIC;

CREATE FUNCTION private.va_protect_idempotency() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF ROW(NEW.workspace_id,NEW.worker_id,NEW.operation,NEW.idempotency_key,NEW.payload_hash,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.workspace_id,OLD.worker_id,OLD.operation,OLD.idempotency_key,OLD.payload_hash,OLD.created_at) THEN
 RAISE EXCEPTION 'idempotency payload binding is immutable'; END IF;
 IF OLD.resource_id IS NOT NULL AND NEW.resource_id IS DISTINCT FROM OLD.resource_id THEN
 RAISE EXCEPTION 'idempotency resource binding is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER va_idempotency_guard BEFORE UPDATE ON public.va_idempotency FOR EACH ROW EXECUTE FUNCTION private.va_protect_idempotency();
REVOKE ALL ON FUNCTION private.va_protect_idempotency() FROM PUBLIC;

-- Invoker helpers: worker self-read policy never calls membership helper.
CREATE FUNCTION public.va_actor_id() RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
CREATE FUNCTION public.va_active_member(workspace uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.va_workers w WHERE w.id=public.va_actor_id() AND w.workspace_id=workspace AND w.active)
$$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['va_workspaces','va_workers','va_sessions','va_turns','va_proposals','va_attempts','va_records','va_speech_sessions','va_usage_events','va_idempotency'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['va_calendar_connections','va_credentials','va_rate_limits','va_operation_events'] LOOP
  EXECUTE format('ALTER TABLE private.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON private.%I FROM PUBLIC',t);
 END LOOP;
END $$;
-- Supabase has these roles. Plain Postgres users run db/bootstrap-local.sql first.
CREATE POLICY va_worker_self ON public.va_workers FOR SELECT TO authenticated USING(id=public.va_actor_id());
CREATE POLICY va_workspace_member ON public.va_workspaces FOR SELECT TO authenticated USING(public.va_active_member(id));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['va_sessions','va_turns','va_proposals','va_attempts','va_records','va_speech_sessions','va_usage_events','va_idempotency'] LOOP
 EXECUTE format('CREATE POLICY va_owner_read ON public.%I FOR SELECT TO authenticated USING(worker_id=public.va_actor_id() AND public.va_active_member(workspace_id))',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['va_workspaces','va_workers','va_sessions','va_turns','va_proposals','va_attempts','va_records','va_speech_sessions','va_usage_events','va_idempotency'] LOOP
 EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated',t);
 EXECUTE format('GRANT SELECT ON public.%I TO authenticated',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO service_role',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['va_calendar_connections','va_credentials','va_rate_limits','va_operation_events'] LOOP
 EXECUTE format('REVOKE ALL ON private.%I FROM anon,authenticated',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON private.%I TO service_role',t);
 END LOOP;
END $$;
GRANT USAGE ON SCHEMA public TO authenticated,service_role;
REVOKE ALL ON SCHEMA private FROM anon,authenticated;
GRANT USAGE ON SCHEMA private TO service_role;
REVOKE ALL ON FUNCTION public.va_actor_id(),public.va_active_member(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.va_actor_id(),public.va_active_member(uuid) TO authenticated,service_role;
COMMIT;
