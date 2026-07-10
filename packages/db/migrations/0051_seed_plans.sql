-- Seed plans (self-seeding flows): a persisted, human-reviewable document plan
-- proposed by the source-grounded outline_flow_seed job. status: proposed →
-- approved | dismissed | superseded (a newer proposed plan supersedes an older
-- un-reviewed one for the same flow). charter/persona are RUN-SCOPED text (flow
-- config's value when set, else the model's proposal, as edited by the
-- reviewer) — flow config remains the only durable home. items is the
-- SeedPlanItem[] JSONB (stable per-item uuids, per-item status + draftJobId).
-- source_hash is hashSourceDescriptors() of the planning input, compared by the
-- seed_bootstrap dismissal guard so a dismissed plan is not re-proposed until
-- the flow's sources change.
CREATE TABLE IF NOT EXISTS seed_plans (
  id UUID PRIMARY KEY,
  flow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  origin TEXT NOT NULL,
  charter TEXT,
  persona TEXT,
  charter_proposed BOOLEAN NOT NULL DEFAULT FALSE,
  persona_proposed BOOLEAN NOT NULL DEFAULT FALSE,
  items JSONB NOT NULL,
  rationale TEXT NOT NULL,
  notes TEXT,
  outline_job_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT seed_plans_outline_job_unique UNIQUE (outline_job_id)
);

CREATE INDEX IF NOT EXISTS seed_plans_flow_created_idx
  ON seed_plans (flow_id, created_at DESC);

-- Link proposals back to the plan item that spawned them (progress display).
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS seed_plan_id UUID;
