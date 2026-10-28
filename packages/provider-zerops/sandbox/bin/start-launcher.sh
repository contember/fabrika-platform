#!/bin/sh
# Starts the dev launcher detached in its own session and returns. Its output goes to a file only root reads: the
# launcher reports its log to Control itself.
set -eu

BIN=$(dirname "$0")
STATE=/var/lib/fabrika

if [ ! -f "$STATE/env" ] || [ ! -f /app/fabrika/dev.generated.json ]; then
	echo 'fabrika sandbox: no deploy left a launcher configuration and environment'
	exit 1
fi
pid=$(cat "$STATE/launcher.pid" 2>/dev/null || true)
case "$pid" in
'' | *[!0-9]*) ;;
*)
	if kill -0 "$pid" 2>/dev/null; then
		echo "fabrika sandbox: a launcher is already running (pid $pid)"
		exit 1
	fi
	;;
esac
rm -f /app/fabrika/dev-booted
umask 077
setsid /bin/sh "$BIN/run-launcher.sh" </dev/null >"$STATE/launcher.log" 2>&1 &
