-- Uses the pg_cron extension installed by the job-dispatch migration (not run in the PGlite tests,
-- like 202609170002_retention_schedule.sql). Apply after 202610190002_menu_ordering.sql. Running it
-- again keeps one job: pg_cron updates a schedule with the same name.
set lock_timeout = '5s';
select cron.schedule('orderly-menu-purge','*/10 * * * *','select public.purge_menu_ordering()');
notify pgrst, 'reload schema';
