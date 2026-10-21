/**
 * The correlation id written to `auth_log` and `audit_events`, and the rule about where it may come from.
 *
 * Same shape as `src/client-address.ts`: IAM does not choose a header. The COMPOSITION ROOT names the
 * one header its own ingress overwrites, and shared code reads that one and nothing else. Naming none
 * is supported and means every request gets a generated id.
 *
 *   - `src/index.ts` (Cloudflare) — `cf-ray`. The Worker holds its own Custom Domain, so no proxy hop
 *     strips a caller's `X-Request-Id`; only the edge-written ray id is outside the caller's reach.
 *   - `src/node/server.ts` (Bun/Zerops) — `X-Request-Id`, which the Caddy proxy deletes at ingress and
 *     re-injects. Once the installation's proxy secret is configured, a request without it gets a
 *     generated id (`src/proxy-proof.ts`).
 *
 * Even a trusted header is bounded: an audit column never takes an unbounded or free-form string. The
 * `IamRpc` surface (`src/rpc.ts`) holds the `requestId` its callers pass to the same rule.
 */

/** Longest id we store. A UUID is 36 characters and a `cf-ray` about 20. */
const MAX_LENGTH = 64

/**
 * The characters a UUID, a UUIDv7, or a `cf-ray` (`<hex>-<colo>`) use. It excludes `,` and space, so
 * the `", "` join that `Headers.get` applies to a repeated header never passes.
 */
const ALLOWED = /^[A-Za-z0-9._:-]+$/

/** A fresh id, for a composition that names no header or a request whose value was refused. */
export function generateRequestId(): string {
	return crypto.randomUUID()
}

/** Read the id from the named header, or generate one when the header is unnamed, absent, or invalid. */
export function readRequestId(request: Request, header: string | undefined, generate: () => string = generateRequestId): string {
	if (header === undefined || header === '') {
		return generate()
	}
	return acceptRequestId(request.headers.get(header), generate)
}

/**
 * Keep a correlation id that is within the length cap and the allowlist, or replace it with a generated
 * one. Never truncated: a cut id could collide with another request's trail.
 */
export function acceptRequestId(value: string | null, generate: () => string = generateRequestId): string {
	return value !== null && value.length <= MAX_LENGTH && ALLOWED.test(value) ? value : generate()
}
