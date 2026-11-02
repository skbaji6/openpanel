-- Lets each purge chunk find old events without scanning the table. Plain btree, not BRIN: purged
-- and retained rows interleave on disk (kept events of live journeys), so block ranges stay mixed.
-- No CONCURRENTLY, because migrations run inside one transaction.
CREATE INDEX IF NOT EXISTS events_event_time_idx ON nudge.events (event_time);
