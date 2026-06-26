-- Source-sync Scope B: source changes now become first-class proposals and
-- execution history lives in maintenance_runs. Keep only baseline state.
DROP TABLE IF EXISTS source_sync_runs;
