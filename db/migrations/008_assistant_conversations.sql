BEGIN;
ALTER TABLE public.va_sessions DROP CONSTRAINT va_sessions_state_check;
ALTER TABLE public.va_sessions ADD CONSTRAINT va_sessions_state_check CHECK(state IN ('captured','clarifying','ready','confirming','booked','note_saved','booking_unknown','failed','note_ready','task_ready','task_saved'));
ALTER TABLE public.va_sessions ADD COLUMN assistant_view jsonb CHECK(assistant_view IS NULL OR jsonb_typeof(assistant_view)='object');
CREATE OR REPLACE FUNCTION private.va_audit_snapshot(table_name text, row_data jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) || CASE WHEN table_name='va_tasks' THEN jsonb_build_object('assigneeUserCode',(SELECT user_code FROM public.va_workers WHERE id=(row_data->>'assignee_worker_id')::uuid),'creatorUserCode',(SELECT user_code FROM public.va_workers WHERE id=(row_data->>'worker_id')::uuid)) ELSE '{}'::jsonb END FROM jsonb_each(row_data)
 WHERE key=ANY(CASE table_name
 WHEN 'va_sessions' THEN ARRAY['state','version','facts','assistant_view']
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
COMMIT;
