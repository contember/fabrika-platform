#!/bin/sh
# PID 1 of a dev workspace sandbox. Starts PostgreSQL on 127.0.0.1, then the dev launcher when a deploy left its
# configuration and environment, so a cold boot serves again without Control. Without them the sandbox idles. The
# scripts it starts are the ones the last deploy uploaded (`bin/current` names their version).
set -u

STATE=/var/lib/fabrika
PGDATA=$STATE/postgres

uploaded() {
	version=$(cat "$STATE/bin/current" 2>/dev/null || true)
	case "$version" in
	'' | *[!0-9a-f]*) return 1 ;;
	esac
	[ -f "$STATE/bin/$version/$1" ] && echo "$STATE/bin/$version/$1"
}

shutdown() {
	if stop=$(uploaded stop.sh); then /bin/sh "$stop" launcher; fi
	su-exec postgres pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1
	exit 0
}
trap shutdown TERM INT

mkdir -p "$STATE" /run/postgresql
# Traversable only: PostgreSQL reaches its own directory below it; every file holding a credential is 0600.
chmod 711 "$STATE"
chown postgres:postgres /run/postgresql
# Only root and PostgreSQL reach the socket, which trusts every local connection.
chmod 700 /run/postgresql
# Pidfiles name processes of an earlier boot; their pids may belong to anything now.
rm -f "$STATE"/*.pid

if [ ! -s "$PGDATA/PG_VERSION" ]; then
	rm -rf "$PGDATA"
	mkdir -p "$PGDATA"
	chown postgres:postgres "$PGDATA"
	chmod 700 "$PGDATA"
	# TCP needs the superuser's password, which the first deploy sets (`bin/postgres-auth.sh`).
	if su-exec postgres initdb -D "$PGDATA" -U postgres --auth-local=trust --auth-host=scram-sha-256 --encoding=UTF8 >"$STATE/initdb.log" 2>&1; then
		printf '%s\n' 'local all all trust' 'host all all 127.0.0.1/32 scram-sha-256' >"$PGDATA/pg_hba.conf"
		printf '%s\n' "listen_addresses = '127.0.0.1'" >>"$PGDATA/postgresql.conf"
	else
		echo "fabrika sandbox: initdb failed; see $STATE/initdb.log"
	fi
fi

# PID 1 runs no PostgreSQL yet, so a lock file left by a stopped sandbox is stale.
rm -f "$PGDATA/postmaster.pid"
if ! su-exec postgres pg_ctl -D "$PGDATA" -w -t 60 -l "$PGDATA/server.log" start >/dev/null; then
	echo "fabrika sandbox: PostgreSQL did not start; see $PGDATA/server.log"
fi

if [ -f "$STATE/env" ] && [ -f /app/fabrika/dev.generated.json ] && start=$(uploaded start-launcher.sh); then
	/bin/sh "$start"
fi

while :; do
	sleep 3600 &
	wait $!
done
