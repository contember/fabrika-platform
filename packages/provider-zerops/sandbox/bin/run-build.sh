#!/bin/sh
# Runs the build steps the deploy wrote to /var/lib/fabrika/build/<n>.sh, in order, each as the unprivileged build user
# with a clean environment from the application root, and stops at the first failure with its exit code. Whatever the
# build started is killed when it ends, and root owns the application root again.
set -eu

STATE=/var/lib/fabrika
STEPS=$STATE/build
BUILD_USER=fabrika-build
COUNT=$1

finish() {
	code=$?
	su-exec "$BUILD_USER" kill -KILL -1 2>/dev/null || true
	chown -R root:root /app 2>/dev/null || true
	rm -f "$STATE/build.pid"
	exit "$code"
}
trap finish EXIT
echo $$ >"$STATE/build.pid"
chown -R "$BUILD_USER:$BUILD_USER" /app

step=1
while [ "$step" -le "$COUNT" ]; do
	echo "fabrika-build: step $step/$COUNT"
	code=0
	(cd /app && exec env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/home/$BUILD_USER \
		su-exec "$BUILD_USER" /bin/sh -e "$STEPS/$step.sh") || code=$?
	if [ "$code" -ne 0 ]; then
		echo "fabrika-build: step $step/$COUNT failed with exit code $code"
		exit "$code"
	fi
	step=$((step + 1))
done
echo 'fabrika-build: done'
