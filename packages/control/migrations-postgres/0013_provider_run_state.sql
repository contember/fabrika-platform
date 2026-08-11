-- Credential-free provider-owned progress needed to resume an external deploy operation.
ALTER TABLE runs ADD COLUMN provider_state_json TEXT;

-- Durable cancellation ownership freezes provider-side lifecycle writes until cleanup completes.
ALTER TABLE runs ADD COLUMN cancel_requested_at INTEGER;
