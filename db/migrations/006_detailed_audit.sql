BEGIN;
ALTER TABLE private.va_operation_events ADD COLUMN session_id uuid;
ALTER TABLE private.va_operation_events ADD COLUMN content jsonb NOT NULL DEFAULT '{}';
ALTER TABLE private.va_operation_events ADD COLUMN content_redacted_at timestamptz;
CREATE INDEX va_operations_workspace_page ON private.va_operation_events(workspace_id,created_at DESC,id DESC);
CREATE INDEX va_operations_worker_page ON private.va_operation_events(workspace_id,actor_worker_id,created_at DESC,id DESC);
CREATE INDEX va_operations_session ON private.va_operation_events(session_id) WHERE session_id IS NOT NULL;
-- Allowlisted fields only: never serialize credentials, hashes, leases, tokens or audio.
CREATE FUNCTION private.va_audit_snapshot(table_name text, row_data jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) FROM jsonb_each(row_data)
 WHERE key=ANY(CASE table_name
 WHEN 'va_sessions' THEN ARRAY['state','version','facts']
 WHEN 'va_turns' THEN ARRAY['speaker','body','source','turn_no']
 WHEN 'va_proposals' THEN ARRAY['status','version','session_version','snapshot','expires_at','checked_at']
 WHEN 'va_attempts' THEN ARRAY['status','error_code','confirmed_at','dispatch_at','resolved_at','starts_at','ends_at','time_zone','event_id','proposal_id','recovery_generation']
 WHEN 'va_records' THEN ARRAY['kind','title','body','location','starts_at','ends_at','time_zone','outcome','booking_attempt_id']
 WHEN 'va_tasks' THEN ARRAY['title','status']
 WHEN 'va_internal_events' THEN ARRAY['title','location','starts_at','ends_at','time_zone','status','event_id']
 WHEN 'va_speech_sessions' THEN ARRAY['provider','status','started_at','ended_at','audio_seconds','error_code']
 WHEN 'va_usage_events' THEN ARRAY['provider','operation','audio_seconds','input_tokens','output_tokens','estimated_cost_aed','cost_status']
 ELSE ARRAY[]::text[] END)
$$;
CREATE OR REPLACE FUNCTION private.va_audit_workspace_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,private AS $$
DECLARE who uuid; ws uuid; code text; alias text; sid uuid; newer jsonb; older jsonb; payload jsonb; metadata jsonb; event_name text;
BEGIN
 -- Retention must not copy expired OLD text back into a fresh audit event.
 IF TG_OP='UPDATE' AND to_jsonb(NEW)->>'content_redacted_at' IS NOT NULL THEN RETURN NEW; END IF;
 newer:=private.va_audit_snapshot(TG_TABLE_NAME,to_jsonb(NEW));
 older:=CASE WHEN TG_OP='UPDATE' THEN private.va_audit_snapshot(TG_TABLE_NAME,to_jsonb(OLD)) ELSE NULL END;
 IF TG_OP='UPDATE' AND newer IS NOT DISTINCT FROM older THEN RETURN NEW; END IF;
 who:=coalesce(nullif(current_setting('nova.actor_id',true),'')::uuid,NEW.worker_id);
 SELECT workspace_id,user_code,display_name INTO ws,code,alias FROM public.va_workers WHERE id=who;
 alias:=coalesce(nullif(current_setting('nova.actor_alias',true),''),alias);
 sid:=CASE WHEN TG_TABLE_NAME='va_sessions' THEN NEW.id ELSE (to_jsonb(NEW)->>'session_id')::uuid END;
 event_name:=TG_TABLE_NAME||'.'||lower(TG_OP);
 payload:=jsonb_build_object('before',older,'after',newer);
 metadata:=jsonb_build_object('userCode',coalesce(code,'worker'),'alias',alias,'entity',TG_TABLE_NAME,'operation',lower(TG_OP),'status',coalesce(newer->>'status',newer->>'state'),'source',newer->>'source','sessionId',sid);
 IF TG_TABLE_NAME='va_turns' THEN
  event_name:=CASE WHEN NEW.speaker='user' THEN 'conversation.user_message' ELSE 'conversation.agent_reply' END;
  payload:=jsonb_build_object('text',NEW.body,'after',newer);
  metadata:=metadata||jsonb_build_object('speaker',NEW.speaker,'turnNumber',NEW.turn_no);
 ELSIF TG_TABLE_NAME='va_usage_events' THEN
  event_name:='provider.'||NEW.operation;
  metadata:=metadata||jsonb_build_object('provider',NEW.provider,'speechSessionId',NEW.speech_session_id);
  payload:=jsonb_build_object('after',newer);
 ELSIF TG_TABLE_NAME='va_attempts' AND TG_OP='INSERT' THEN
  payload:=payload||jsonb_build_object('confirmationSnapshot',(SELECT snapshot FROM public.va_proposals WHERE id=NEW.proposal_id));
  metadata:=metadata||jsonb_build_object('decision','confirmed','proposalId',NEW.proposal_id,'eventId',NEW.event_id,'confirmedAt',NEW.confirmed_at);
 END IF;
 INSERT INTO private.va_operation_events(workspace_id,actor_worker_id,subject_id,event_type,detail,session_id,content)
 VALUES(ws,who,NEW.id,event_name,metadata,sid,payload);
 RETURN NEW;
END $$;
CREATE TRIGGER va_turn_audit AFTER INSERT ON public.va_turns FOR EACH ROW EXECUTE FUNCTION private.va_audit_workspace_mutation();
CREATE TRIGGER va_proposal_audit AFTER INSERT OR UPDATE ON public.va_proposals FOR EACH ROW EXECUTE FUNCTION private.va_audit_workspace_mutation();
CREATE TRIGGER va_record_audit AFTER INSERT OR UPDATE ON public.va_records FOR EACH ROW EXECUTE FUNCTION private.va_audit_workspace_mutation();
CREATE TRIGGER va_usage_audit AFTER INSERT ON public.va_usage_events FOR EACH ROW EXECUTE FUNCTION private.va_audit_workspace_mutation();
CREATE TRIGGER va_speech_audit AFTER INSERT OR UPDATE ON public.va_speech_sessions FOR EACH ROW EXECUTE FUNCTION private.va_audit_workspace_mutation();
-- Existing durable turns can be represented accurately without inventing a historical
-- alias. Only content still within its text-retention window is copied.
INSERT INTO private.va_operation_events(workspace_id,actor_worker_id,subject_id,event_type,detail,session_id,content,created_at)
SELECT t.workspace_id,t.worker_id,t.id,
 CASE WHEN t.speaker='user' THEN 'conversation.user_message' ELSE 'conversation.agent_reply' END,
 jsonb_build_object('userCode',coalesce(w.user_code,'worker'),'alias','Historical alias unavailable','source',t.source,'speaker',t.speaker,'turnNumber',t.turn_no,'backfilled',true),
 t.session_id,jsonb_build_object('text',t.body),t.created_at
FROM public.va_turns t JOIN public.va_workers w ON w.id=t.worker_id
WHERE t.body IS NOT NULL AND t.content_redacted_at IS NULL AND t.created_at>=now()-interval '30 days';
REVOKE ALL ON FUNCTION private.va_audit_snapshot(text,jsonb) FROM PUBLIC;
COMMIT;
