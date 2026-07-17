-- 0057: Snapshot the answer's confidence onto the questionnaire item so the
-- worksheet is stable and low-confidence answers can be SHOWN with a badge
-- instead of being suppressed. Nullable: existing rows and true abstains have
-- no confidence. See docs/superpowers/specs/2026-07-17-questionnaire-trust-design.md.
ALTER TABLE questionnaire_items
  ADD COLUMN IF NOT EXISTS confidence text
  CHECK (confidence IS NULL OR confidence IN ('high', 'medium', 'low', 'unknown'));
