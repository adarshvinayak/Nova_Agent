import type { PoolClient } from 'pg';

/** Call inside a transaction; dry-run callers roll back the entire transaction. */
export async function applyRetention(db: PoolClient, now = new Date()) {
  const counts: Record<string, number> = {};
  await db.query("SELECT pg_advisory_xact_lock(hashtext('voiceagent_retention'))");
  // Session lock order matches mutation paths; skip work currently held by another request.
  // A pending/uncertain write needs its original content for exact readback comparison.
  await db.query(`CREATE TEMP TABLE va_retention_sessions ON COMMIT DROP AS
    SELECT s.id FROM public.va_sessions s WHERE s.content_redacted_at IS NULL
    AND s.updated_at < $1::timestamptz - interval '30 days'
    AND (s.processing_until IS NULL OR s.processing_until < $1)
    AND NOT EXISTS(SELECT 1 FROM public.va_attempts a WHERE a.session_id=s.id AND a.status IN ('reserved','writing','unknown'))
    FOR UPDATE OF s SKIP LOCKED`, [now]);
  async function execute(name: string, sql: string, values: unknown[] = [now]) {
    counts[name] = (await db.query(sql, values)).rowCount ?? 0;
  }
  await execute('expiredProposals', `UPDATE public.va_proposals SET status='expired' WHERE session_id IN(SELECT id FROM va_retention_sessions) AND status='ready'`, []);
  await execute('redactedTurns', `UPDATE public.va_turns SET body=NULL,content_redacted_at=$1 WHERE session_id IN(SELECT id FROM va_retention_sessions) AND content_redacted_at IS NULL`);
  await execute('redactedRecords', `UPDATE public.va_records SET title=NULL,body=NULL,location=NULL,content_redacted_at=$1 WHERE session_id IN(SELECT id FROM va_retention_sessions) AND content_redacted_at IS NULL`);
  await execute('redactedProposals', `UPDATE public.va_proposals SET snapshot='{}',content_redacted_at=$1 WHERE session_id IN(SELECT id FROM va_retention_sessions) AND content_redacted_at IS NULL`);
  await execute('redactedDemoEvents', `UPDATE private.va_demo_events d SET snapshot=jsonb_build_object('title','Content expired','location',NULL,'start',d.snapshot->'start','end',d.snapshot->'end','timeZone',d.snapshot->'timeZone')
    FROM public.va_attempts a WHERE a.session_id IN(SELECT id FROM va_retention_sessions) AND a.calendar_id=d.calendar_id AND a.event_id=d.event_id`, []);
  await execute('redactedSessions', `UPDATE public.va_sessions SET facts='{}',content_redacted_at=$1,processing_token=NULL,processing_until=NULL,version=version+1 WHERE id IN(SELECT id FROM va_retention_sessions)`);
  // Abandoned speech has no booking authority. Preserve its unknown cost instead of fabricating zero.
  await execute('abandonedSpeech', `UPDATE public.va_speech_sessions SET status='abandoned',ended_at=$1 WHERE status IN('issued','streaming') AND started_at < $1::timestamptz - interval '1 hour'`);
  await execute('deletedUsage', `DELETE FROM public.va_usage_events WHERE created_at < $1::timestamptz - interval '90 days'`);
  await execute('deletedSpeech', `DELETE FROM public.va_speech_sessions s WHERE s.ended_at < $1::timestamptz - interval '90 days' AND s.status IN('finished','failed','abandoned') AND NOT EXISTS(SELECT 1 FROM public.va_usage_events u WHERE u.speech_session_id=s.id)`);
  await execute('deletedOperationalLogs', `DELETE FROM private.va_operation_events o WHERE o.created_at < $1::timestamptz - interval '90 days'
    AND NOT EXISTS(SELECT 1 FROM public.va_attempts a WHERE (o.subject_id=a.id OR o.subject_id=a.session_id OR o.subject_id=a.proposal_id)
      AND (a.status IN('reserved','writing','unknown') OR a.ends_at >= $1::timestamptz - interval '90 days'))`);
  await execute('deletedExpiredCredentials', `DELETE FROM private.va_credentials WHERE expires_at < $1::timestamptz - interval '90 days'`);
  await execute('deletedOAuthStates', `DELETE FROM private.va_oauth_states WHERE expires_at < $1::timestamptz - interval '90 days'`);
  await execute('deletedRateBuckets', `DELETE FROM private.va_rate_limits WHERE expires_at < $1`);
  counts.protectedUnresolvedSessions = Number((await db.query(`SELECT count(DISTINCT s.id) FROM public.va_sessions s JOIN public.va_attempts a ON a.session_id=s.id
    WHERE s.updated_at < $1::timestamptz - interval '30 days' AND a.status IN('reserved','writing','unknown')`, [now])).rows[0].count);
  // Booking attempts, session/record skeletons and idempotency keys are retained. Never reopen a past authorized operation.
  return counts;
}
