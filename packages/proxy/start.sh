#!/bin/sh
# Runtime entrypoint: the auth service on loopback, Caddy in front of it.
#
# Failure mode by design: if the auth service is down, Caddy's forward_auth subrequest fails and
# Caddy answers 502 — a non-2xx, which it returns to the client instead of continuing to the app.
# So "the auth service died" denies every request rather than letting any through.
set -eu

cd "$(dirname "$0")/../.."

# Keep the auth service alive without a supervisor: if it exits, restart it. The proxy stays thin.
(
	while true; do
		./fabrika-proxy || true
		sleep 1
	done
) &

exec ./caddy run --config ./caddy.json
