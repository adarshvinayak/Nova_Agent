BEGIN;
DROP POLICY va_tasks_member ON public.va_tasks;
CREATE POLICY va_tasks_member ON public.va_tasks FOR SELECT TO authenticated USING(public.va_active_member(workspace_id) AND EXISTS(SELECT 1 FROM public.va_workers w WHERE w.id=public.va_actor_id() AND (w.role='admin' OR coalesce((w.permissions->>'tasks')::boolean,true))));
COMMIT;
