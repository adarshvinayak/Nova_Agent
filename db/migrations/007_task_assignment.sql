BEGIN;
ALTER TABLE public.va_tasks ADD COLUMN assignee_worker_id uuid;
UPDATE public.va_tasks SET assignee_worker_id=worker_id;
ALTER TABLE public.va_tasks ALTER COLUMN assignee_worker_id SET NOT NULL;
ALTER TABLE public.va_tasks ADD CONSTRAINT va_task_assignee_workspace FOREIGN KEY(workspace_id,assignee_worker_id) REFERENCES public.va_workers(workspace_id,id);
ALTER TABLE public.va_tasks ADD COLUMN due_at timestamptz;
ALTER TABLE public.va_tasks ADD COLUMN source_session_id uuid;
ALTER TABLE public.va_tasks ADD CONSTRAINT va_task_source_owner FOREIGN KEY(workspace_id,worker_id,source_session_id) REFERENCES public.va_sessions(workspace_id,worker_id,id);
CREATE UNIQUE INDEX va_task_source_session ON public.va_tasks(source_session_id) WHERE source_session_id IS NOT NULL;
CREATE INDEX va_task_assignee_due ON public.va_tasks(workspace_id,assignee_worker_id,status,due_at);
CREATE OR REPLACE FUNCTION private.va_audit_snapshot(table_name text, row_data jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) || CASE WHEN table_name='va_tasks' THEN jsonb_build_object('assigneeUserCode',(SELECT user_code FROM public.va_workers WHERE id=(row_data->>'assignee_worker_id')::uuid),'creatorUserCode',(SELECT user_code FROM public.va_workers WHERE id=(row_data->>'worker_id')::uuid)) ELSE '{}'::jsonb END FROM jsonb_each(row_data)
 WHERE key=ANY(CASE table_name
 WHEN 'va_sessions' THEN ARRAY['state','version','facts']
 WHEN 'va_turns' THEN ARRAY['speaker','body','source','turn_no']
 WHEN 'va_proposals' THEN ARRAY['status','version','session_version','snapshot','expires_at','checked_at']
 WHEN 'va_attempts' THEN ARRAY['status','error_code','confirmed_at','dispatch_at','resolved_at','starts_at','ends_at','time_zone','event_id','proposal_id','recovery_generation']
 WHEN 'va_records' THEN ARRAY['kind','title','body','location','starts_at','ends_at','time_zone','outcome','booking_attempt_id']
 WHEN 'va_tasks' THEN ARRAY['title','status','assignee_worker_id','worker_id','due_at','source_session_id']
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
 sid:=CASE WHEN TG_TABLE_NAME='va_sessions' THEN NEW.id WHEN TG_TABLE_NAME='va_tasks' THEN (to_jsonb(NEW)->>'source_session_id')::uuid ELSE (to_jsonb(NEW)->>'session_id')::uuid END;
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
COMMIT;
