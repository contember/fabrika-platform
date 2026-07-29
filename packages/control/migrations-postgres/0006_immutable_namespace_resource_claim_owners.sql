CREATE FUNCTION reject_namespace_resource_claim_owner_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD.owner_app_id IS DISTINCT FROM NEW.owner_app_id
		OR OLD.owner_env IS DISTINCT FROM NEW.owner_env
	THEN
		RAISE EXCEPTION 'namespace resource claim owner is immutable'
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;

CREATE TRIGGER namespace_resource_claims_owner_immutable
BEFORE UPDATE OF owner_app_id, owner_env ON namespace_resource_claims
FOR EACH ROW
EXECUTE FUNCTION reject_namespace_resource_claim_owner_change();
