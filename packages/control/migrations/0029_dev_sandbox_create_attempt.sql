-- The bind that inserted a `creating` row, so only that bind's failed create removes it: a concurrent bind on the same
-- workspace keeps its sandbox. Rows from before carry none, and maintenance removes them if they never get a sandbox.
ALTER TABLE dev_sandboxes ADD COLUMN create_attempt TEXT;
