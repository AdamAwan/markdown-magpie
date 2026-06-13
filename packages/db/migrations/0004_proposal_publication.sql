ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS publication jsonb;
