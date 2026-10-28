#!/bin/sh
# Converges PostgreSQL's authentication before every build: the socket only root and PostgreSQL reach trusts every
# connection, and TCP on 127.0.0.1 takes the superuser's password, which only root can read. The build user can thus
# neither read a credential nor connect as the superuser.
set -eu

STATE=/var/lib/fabrika
PGDATA=$STATE/postgres
PASSWORD_FILE=$STATE/postgres-password

chown postgres:postgres /run/postgresql
chmod 700 /run/postgresql

waited=0
until su-exec postgres pg_isready -q -h /run/postgresql; do
	if [ "$waited" -ge 60 ]; then
		echo 'fabrika sandbox: PostgreSQL is not running'
		exit 1
	fi
	sleep 1
	waited=$((waited + 1))
done

if [ ! -s "$PASSWORD_FILE" ]; then
	(
		umask 077
		head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$PASSWORD_FILE.tmp"
	)
	mv "$PASSWORD_FILE.tmp" "$PASSWORD_FILE"
fi
chmod 600 "$PASSWORD_FILE"

# Through stdin, so the password is in no process's arguments.
printf "ALTER ROLE postgres PASSWORD '%s';\n" "$(cat "$PASSWORD_FILE")" \
	| su-exec postgres psql -X -q -v ON_ERROR_STOP=1 -h /run/postgresql -U postgres -d postgres -f - >/dev/null
printf '%s\n' 'local all all trust' 'host all all 127.0.0.1/32 scram-sha-256' >"$PGDATA/pg_hba.conf"
chown postgres:postgres "$PGDATA/pg_hba.conf"
su-exec postgres pg_ctl -D "$PGDATA" reload >/dev/null
