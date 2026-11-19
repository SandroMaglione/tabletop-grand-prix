-- Each run's sectors, as a JSON array of whole milliseconds that add up to time_ms, for the
-- boards ordered by one sector. NULL for a run filed before sectors were (`pnpm admin <stage>
-- fill-sectors` drives those again); '[]' for one whose replay no longer drives.
ALTER TABLE runs ADD COLUMN sectors_ms TEXT;
