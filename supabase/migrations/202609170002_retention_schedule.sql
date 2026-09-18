-- Uses the pg_cron extension installed by the job-dispatch migration.
-- No records are deleted until an owner opts in and the 24-hour grace period ends.
select cron.schedule('orderly-retention','19 * * * *','select public.run_retention_batch()');
