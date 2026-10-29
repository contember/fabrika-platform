-- When the first of the IAM keys a workspace sandbox's last bootstrap handed expires: bind_dev bootstraps it again inside
-- the rotation margin. Rows from before carry none, and their keys run to expiry as they did.
ALTER TABLE dev_sandboxes ADD COLUMN keys_expire_at INTEGER;
