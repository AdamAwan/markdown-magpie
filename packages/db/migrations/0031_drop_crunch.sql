-- Retire the scheduled-crunch flow: the patrol lenses (verify, dedupe, split,
-- improve) now cover what the whole-knowledge-base crunch did, so its job types,
-- API feature, and stores are gone. Drop the now-unused tables created by
-- 0010_crunch.sql. Dropping the tables also drops their indexes.

DROP TABLE IF EXISTS crunch_runs;
DROP TABLE IF EXISTS crunch_settings;
