-- The vault ref of the key Fabrika generated for the namespace's dev sandbox host (its Box API key); NULL until a dev
-- environment first needs the host.
ALTER TABLE deployment_namespaces ADD COLUMN sandbox_key_ref TEXT;
