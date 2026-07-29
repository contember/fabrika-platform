CREATE TRIGGER namespace_resource_claims_owner_immutable
BEFORE UPDATE OF owner_app_id, owner_env ON namespace_resource_claims
FOR EACH ROW
WHEN NOT (
	OLD.owner_app_id IS NEW.owner_app_id
	AND OLD.owner_env IS NEW.owner_env
)
BEGIN
	SELECT RAISE(ABORT, 'namespace resource claim owner is immutable');
END;
