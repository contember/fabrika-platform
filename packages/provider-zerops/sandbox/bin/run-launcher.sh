#!/bin/sh
# The launcher process itself: the environment reaches it only through the env file the deploy wrote 0600, never through
# an argument or the sandbox's launch environment, which the sandbox host echoes. The database URL gets the local
# superuser's password here, which never leaves the sandbox.
set -eu

STATE=/var/lib/fabrika

set -a
. "$STATE/env"
set +a
if [ -n "${FABRIKA_APP_DATABASE_URL:-}" ]; then
	FABRIKA_APP_DATABASE_URL="postgres://postgres:$(cat "$STATE/postgres-password")@127.0.0.1:5432/postgres"
	export FABRIKA_APP_DATABASE_URL
fi
cd /app
echo $$ >"$STATE/launcher.pid"
exec bun -e 'await import("@fabrika/app/dev").then((dev) => dev.runDevLauncher(process.env))'
