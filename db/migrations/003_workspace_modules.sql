BEGIN;
ALTER TABLE public.va_workers ADD COLUMN user_code text;
ALTER TABLE public.va_workers ADD COLUMN role text NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin'));
ALTER TABLE public.va_workers ADD COLUMN permissions jsonb NOT NULL DEFAULT '{"capture":true,"tasks":true,"calendar":true,"audit":true,"settings":true}' CHECK(jsonb_typeof(permissions)='object');
CREATE UNIQUE INDEX va_worker_code ON public.va_workers(workspace_id,user_code) WHERE user_code IS NOT NULL;
ALTER TABLE private.va_calendar_connections DROP CONSTRAINT va_calendar_connections_provider_check;
ALTER TABLE private.va_calendar_connections ADD CONSTRAINT va_calendar_connections_provider_check CHECK(provider IN ('google','simulated','internal'));
CREATE TABLE public.va_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,worker_id uuid NOT NULL,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 300),status text NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','done')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,worker_id) REFERENCES public.va_workers(workspace_id,id)
);
CREATE TABLE private.va_internal_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,worker_id uuid NOT NULL,
 calendar_id text NOT NULL,event_id text NOT NULL,title text NOT NULL CHECK(length(title) BETWEEN 1 AND 300),location text,
 starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,time_zone text NOT NULL DEFAULT 'Asia/Dubai',intent_hash text,
 status text NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(calendar_id,event_id),CHECK(ends_at>starts_at),
 FOREIGN KEY(workspace_id,worker_id) REFERENCES public.va_workers(workspace_id,id)
);
CREATE INDEX va_internal_events_range ON private.va_internal_events(workspace_id,starts_at,ends_at);
ALTER TABLE public.va_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY va_tasks_member ON public.va_tasks FOR SELECT TO authenticated USING(public.va_active_member(workspace_id) AND EXISTS(SELECT 1 FROM public.va_workers w WHERE w.id=public.va_actor_id() AND (w.role='admin' OR coalesce((w.permissions->>'tasks')::boolean,true))));
REVOKE ALL ON public.va_tasks FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.va_tasks TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.va_tasks TO service_role;
ALTER TABLE private.va_internal_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.va_internal_events FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON private.va_internal_events TO service_role;
-- Every persisted operation carries a stable user code and the alias used for that operation.
CREATE FUNCTION private.va_audit_workspace_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,private AS $$
DECLARE who uuid; ws uuid; subject uuid; code text; alias text;
BEGIN
 who:=nullif(current_setting('nova.actor_id',true),'')::uuid;
 alias:=nullif(current_setting('nova.actor_alias',true),'');
 IF who IS NULL THEN
  IF TG_TABLE_NAME IN ('va_sessions','va_tasks','va_internal_events') THEN who:=NEW.worker_id;
  ELSIF TG_TABLE_NAME='va_attempts' THEN who:=NEW.worker_id;
  ELSE RETURN NEW; END IF;
 END IF;
 SELECT workspace_id,user_code,display_name INTO ws,code,alias FROM public.va_workers WHERE id=who;
 alias:=coalesce(nullif(current_setting('nova.actor_alias',true),''),alias);
 subject:=NEW.id;
 INSERT INTO private.va_operation_events(workspace_id,actor_worker_id,subject_id,event_type,detail)
 VALUES(ws,who,subject,TG_TABLE_NAME||'.'||lower(TG_OP),jsonb_build_object('userCode',coalesce(code,'worker'),'alias',alias,
 'status',CASE WHEN TG_TABLE_NAME IN ('va_tasks','va_attempts','va_internal_events') THEN to_jsonb(NEW)->>'status' ELSE to_jsonb(NEW)->>'state' END));
 RETURN NEW;
END $$;
CREATE TRIGGER va_session_audit AFTER INSERT OR UPDATE ON public.va_sessions FOR EACH ROW EXECUTE FUNCTION private.va_audit_workspace_mutation();
CREATE TRIGGER va_attempt_audit AFTER INSERT OR UPDATE ON public.va_attempts FOR EACH ROW EXECUTE FUNCTION private.va_audit_workspace_mutation();
CREATE TRIGGER va_task_audit AFTER INSERT OR UPDATE ON public.va_tasks FOR EACH ROW EXECUTE FUNCTION private.va_audit_workspace_mutation();
CREATE TRIGGER va_internal_event_audit AFTER INSERT OR UPDATE ON private.va_internal_events FOR EACH ROW EXECUTE FUNCTION private.va_audit_workspace_mutation();
REVOKE ALL ON FUNCTION private.va_audit_workspace_mutation() FROM PUBLIC;
COMMIT;
