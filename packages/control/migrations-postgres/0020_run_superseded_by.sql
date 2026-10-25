-- The newer run whose success stopped this one before it started (ADR-0050 §6): an older run never deploys over a
-- newer one. Written in the same statement that fails the run; the approval page says why an approved run did not deploy.
ALTER TABLE runs ADD COLUMN superseded_by TEXT;
