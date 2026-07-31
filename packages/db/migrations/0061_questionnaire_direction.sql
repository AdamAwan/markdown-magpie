-- Per-questionnaire answering direction (docs/questionnaires.md): free text set
-- at creation that steers how ambiguous questions are read ("where ambiguous,
-- assume the question is about the company and not the product"). Immutable by
-- design — answering starts on create, so an edit would leave one questionnaire
-- holding answers written under two different directions. NULL means none, and
-- a questionnaire with no direction behaves exactly as before this column
-- existed. Deliberately NOT on questionnaire_items: immutability makes it
-- uniform across every item of a questionnaire.
ALTER TABLE questionnaires ADD COLUMN direction text;
