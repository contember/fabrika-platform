-- ADR-0083 §4, §8: the protection revision at which IAM last took an environment's mirrored gates (whether its console
-- grants wait, and its `credentials` mode). The maintenance pass writes the gates of every environment whose row is
-- missing or names another revision than the environment's, then records it here, so an installation upgraded to the
-- mirror, a new environment, and a write a protection change could not finish all converge without an operator step.
-- A row is a cache of what IAM acknowledged: losing one only writes the same gates again.
CREATE TABLE iam_gate_mirrors (
	app_id   TEXT NOT NULL,
	env      TEXT NOT NULL,
	revision INTEGER NOT NULL,
	PRIMARY KEY (app_id, env)
);
