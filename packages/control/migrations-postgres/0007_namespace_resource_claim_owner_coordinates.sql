DO $$
DECLARE
	owner_constraint TEXT;
BEGIN
	SELECT conname INTO owner_constraint
	FROM pg_constraint
	WHERE conrelid = 'namespace_resource_claims'::regclass
		AND confrelid = 'app_envs'::regclass
		AND contype = 'f';

	IF owner_constraint IS NULL THEN
		RAISE EXCEPTION 'namespace resource claim owner constraint not found';
	END IF;

	EXECUTE format(
		'ALTER TABLE namespace_resource_claims DROP CONSTRAINT %I',
		owner_constraint
	);
END;
$$;

ALTER TABLE namespace_resource_claims
ADD CONSTRAINT namespace_resource_claims_owner_fk
FOREIGN KEY (owner_app_id, owner_env)
REFERENCES app_envs(app_id, env) ON DELETE RESTRICT;

CREATE FUNCTION reject_namespace_resource_claim_owner_namespace_mismatch()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.owner_app_id IS NOT NULL
		AND NOT EXISTS (
			SELECT 1
			FROM app_envs
			WHERE app_id = NEW.owner_app_id
				AND env = NEW.owner_env
				AND namespace_id = NEW.namespace_id
		)
	THEN
		RAISE EXCEPTION 'namespace resource claim owner belongs to another namespace'
			USING ERRCODE = '23503';
	END IF;
	RETURN NEW;
END;
$$;

CREATE TRIGGER namespace_resource_claims_owner_namespace_match
BEFORE INSERT ON namespace_resource_claims
FOR EACH ROW
EXECUTE FUNCTION reject_namespace_resource_claim_owner_namespace_mismatch();
