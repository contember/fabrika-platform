# @fabrika/installation-contract

The open runtime-neutral contract between `@fabrika/cli` and a
provider-specific platform installation package.

An installation module exports one `installationCli` with its provider id,
supported subset of `init`, `plan`, and `deploy`, provider-specific usage, and
the command runner. The contract validates imported modules at runtime.

Keep this package free of provider implementations, filesystem behavior,
credentials, and a closed provider-id union.
