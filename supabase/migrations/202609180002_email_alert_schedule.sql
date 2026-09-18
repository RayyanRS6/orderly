-- Opt-in recipients only. No subscriptions are created by this migration.
select cron.schedule('orderly-staff-alerts','*/5 * * * *','select public.queue_staff_alerts()');
