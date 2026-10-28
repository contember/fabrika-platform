#!/bin/sh
# Stops the process `/var/lib/fabrika/<name>.pid` names and every process below it: TERM to it, then KILL to what is
# left after a grace period. A missing pidfile or a process already gone is stopped. `build` also kills every process of
# the build user, so no daemon a build started outlives it.
set -u

case "${1:-}" in
launcher | build) ;;
*)
	echo 'usage: stop.sh launcher|build'
	exit 2
	;;
esac
PIDFILE=/var/lib/fabrika/$1.pid
GRACE_SECONDS=10

tree() {
	for child in $(pgrep -P "$1"); do
		tree "$child"
	done
	echo "$1"
}

pid=$(cat "$PIDFILE" 2>/dev/null || true)
case "$pid" in
'' | *[!0-9]*) ;;
*)
	if kill -0 "$pid" 2>/dev/null; then
		before=$(tree "$pid")
		kill -TERM "$pid" 2>/dev/null
		waited=0
		while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$GRACE_SECONDS" ]; do
			sleep 1
			waited=$((waited + 1))
		done
		after=''
		if kill -0 "$pid" 2>/dev/null; then after=$(tree "$pid"); fi
		kill -KILL $before $after 2>/dev/null
	fi
	;;
esac
rm -f "$PIDFILE"
if [ "$1" = build ]; then
	# The kernel signals every process of the build user at once; a fork cannot slip past it.
	su-exec fabrika-build kill -KILL -1 2>/dev/null
fi
exit 0
