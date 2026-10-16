# The image the local stack runs a contract application in: the Bun runtime with ClamAV, as the Zerops build adds it
# for a `scan: true` file collection. The signatures are copied from the ClamAV image, so a build reaches no mirror.
FROM --platform=linux/amd64 clamav/clamav:1.4 AS signatures

FROM oven/bun:1.3.14-alpine
RUN apk add --no-cache clamav
COPY --from=signatures /var/lib/clamav /var/lib/clamav
