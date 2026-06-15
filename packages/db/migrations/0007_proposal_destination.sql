ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS destination_id text;
