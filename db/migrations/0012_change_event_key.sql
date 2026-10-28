-- 0012_change_event_key.sql : record each monitor change event once (WP-QA05).
-- Two checks of one company can overlap (the cron sweep and a manual re-check, on different
-- serverless instances). Both diff the same stored baseline and used to insert every event
-- twice. lib/monitor/runCheck.ts now keys each event by that baseline (eventKey), and this index
-- lets lib/monitor/postgres.ts insert with `on conflict (tenant_id, event_key) do nothing`.
--
-- Apply after 0005_monitor.sql:
--   psql "$DATABASE_URL" -f db/migrations/0012_change_event_key.sql
--
-- Rows written before this migration keep a null key. Postgres treats nulls as distinct in a
-- unique index, so they never conflict and nothing already stored is touched. The table keeps
-- the RLS policy from 0005_monitor.sql; adding a column does not change it.

alter table change_event add column if not exists event_key text;
create unique index if not exists change_event_key_uniq on change_event (tenant_id, event_key);
