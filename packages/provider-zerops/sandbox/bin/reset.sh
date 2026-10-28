#!/bin/sh
# What every deploy runs before it touches the application root: stop the previous launcher and any build still running,
# delete the launcher's environment so the untrusted build cannot read it, and converge PostgreSQL's authentication.
set -eu

BIN=$(dirname "$0")
STATE=/var/lib/fabrika

/bin/sh "$BIN/stop.sh" launcher
/bin/sh "$BIN/stop.sh" build
rm -f "$STATE/env" /app/fabrika/dev-booted
/bin/sh "$BIN/postgres-auth.sh"
