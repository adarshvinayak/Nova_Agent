import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', quiet: true });

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const days = Number(process.argv[2] ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('Provide a report window from 1 to 90 days.');
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    const result = await db.query(`SELECT provider,operation,count(*)::integer AS operations,
      sum(input_tokens)::text AS input_tokens,sum(output_tokens)::text AS output_tokens,sum(audio_seconds)::text AS reported_audio_seconds,
      count(*) FILTER(WHERE cost_status='unknown')::integer AS unknown_cost_operations,
      sum(estimated_cost_aed) FILTER(WHERE cost_status='estimated')::text AS known_estimated_cost_aed
      FROM public.va_usage_events WHERE created_at>=now()-($1::integer*interval '1 day') GROUP BY provider,operation ORDER BY provider,operation`, [days]);
    const pending = await db.query("SELECT status,count(*)::integer AS attempts FROM public.va_attempts WHERE status IN('reserved','writing','unknown') GROUP BY status");
    const capture = await db.query(`SELECT count(*)::integer AS captures FROM public.va_idempotency WHERE operation='capture' AND created_at>=now()-($1::integer*interval '1 day')`, [days]);
    console.log(JSON.stringify({ windowDays: days, captures: capture.rows[0].captures, usage: result.rows, unresolvedBookingStates: pending.rows,
      notes: ['Null costs are unknown, not free. No total cost per capture can be established while provider rates or quantities are unknown.',
        'browser_duration_estimate is untrusted client-reported elapsed duration, not provider-billed audio.', 'This report excludes hosting, database, domain and taxes.'] }, null, 2));
  } finally { await db.end(); }
}
main().catch(() => { console.error('Usage report failed. Verify the database connection and provide an integer window from 1 to 90 days.'); process.exitCode = 1; });
