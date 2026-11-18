# The base of every dev workspace sandbox: Bun, a PostgreSQL that listens on 127.0.0.1 only, the unprivileged user the
# build runs as, and the init script. Built on the sandbox host by `POST /base-build`; its name carries the hash of this
# directory's base files. Every other script reaches a sandbox with each deploy (`bin/`), so a fix needs no new base.
FROM oven/bun:1.4.4-alpine@sha256:5a1fe2d60106ee903ee62008deab884376f18e07bbb6676cc86e9e1e1e710690

# The PostgreSQL major is pinned by the package name; the patch floats, because Alpine drops a revision from its index
# once a newer one ships, and a pinned revision would then fail every later base build.
RUN apk add --no-cache postgresql17 postgresql17-contrib su-exec \
	&& adduser -D -h /home/fabrika-build -s /sbin/nologin -u 10001 fabrika-build

COPY init.sh /usr/local/lib/fabrika/

WORKDIR /app

ENTRYPOINT ["/bin/sh"]
CMD ["/usr/local/lib/fabrika/init.sh"]
