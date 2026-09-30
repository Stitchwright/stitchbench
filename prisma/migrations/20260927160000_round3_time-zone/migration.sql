-- Round 3, time zone: every date is now printed in the company's time zone (Shop.timeZone), not the server's.
-- The Windows program used to print in the PC's own zone, and its one company kept the 'America/New_York' default.
-- Where this database runs in a real place's zone (the program's own Postgres takes the PC's zone) and holds one company
-- still on that default, give it the PC's zone so nothing it prints moves. A hosted database runs on UTC: untouched.
UPDATE "Shop"
SET "timeZone" = current_setting('TimeZone')
WHERE "timeZone" = 'America/New_York'
  AND current_setting('TimeZone') LIKE '%/%'
  AND current_setting('TimeZone') NOT LIKE 'Etc/%'
  AND current_setting('TimeZone') <> 'America/New_York'
  AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = current_setting('TimeZone'))
  AND (SELECT count(*) FROM "Shop") = 1;
