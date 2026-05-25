-- ──────────────────────────────────────────────────────────────
-- 009 — Daily tool usage
--
-- Previously, each tool_usage row stored a CUMULATIVE WEEKLY total
-- (one row per facility × tool × Monday). That worked for a weekly
-- summary but couldn't tell us which day each unit was used — so
-- missed days couldn't be back-filled accurately.
--
-- Now each row represents ONE DAY's usage. The unique constraint
-- becomes (facility, tool, usage_date). Weekly totals are SUMmed
-- on demand for the tracker and reports.
--
-- The column rename is in-place. Existing rows keep their Monday
-- date as `usage_date` — treated as "all that week's usage attributed
-- to Monday." Acceptable for the small amount of testing data; new
-- entries are accurate to the day.
-- ──────────────────────────────────────────────────────────────

ALTER TABLE tool_usage RENAME COLUMN week_start_date TO usage_date;

-- The unique constraint and index on the column carry over automatically.
-- No further index changes needed.
