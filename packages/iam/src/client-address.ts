/**
 * The client coordinate a per-client abuse limit is keyed on — and, more importantly, the rule about
 * where it may come from.
 *
 * IAM cannot derive it. Behind a balancer its socket peer IS the balancer, and a forwarding header the
 * caller can write is worse than no limiter because it looks like protection
 * ([backlog 21](../../../docs/backlog/21-rate-limit-the-iam-mint-surface.md),
 * [49](../../../docs/backlog/49-add-trusted-client-rate-limits-to-public-iam.md)). So IAM does not
 * choose a header: the COMPOSITION ROOT names the one header its own ingress guarantees, and shared
 * code reads that one and nothing else. Naming none is a supported configuration — it means this
 * installation cannot see its clients, and the account and deployment-wide buckets carry the load
 * alone, exactly as they did before.
 *
 * The two roots and what they name:
 *
 *   - `src/index.ts` (Cloudflare) — `CF-Connecting-IP`. IAM's Worker holds its own Custom Domain, so
 *     it is reached through Cloudflare's edge, which writes that header and replaces a caller's.
 *   - `src/node/server.ts` (Bun/Zerops) — `CLIENT_ADDRESS_HEADER`, written by the Caddy proxy in front
 *     of it after deleting the caller's. IAM is not publicly routed on that composition (ADR-0022
 *     rule 1), so the proxy is the only thing that can reach this port — the same trust the request-id
 *     header already runs on.
 *
 * A composition must never name a header its ingress does not overwrite. That is the whole invariant.
 */

/** Longest coordinate we will key on. An IPv6 address with a zone id fits with room to spare. */
const MAX_LENGTH = 64

/**
 * Read the coordinate, or `null` when this composition cannot see one.
 *
 * `Headers.get` joins repeats with `", "`, so only the first value is taken: a caller that appends a
 * second copy must not be able to change the key, and a well-formed ingress never sends two.
 */
export function readClientAddress(request: Request, header: string | undefined): string | null {
	if (header === undefined || header === '') {
		return null
	}
	const raw = request.headers.get(header)
	if (raw === null) {
		return null
	}
	const first = (raw.split(',')[0] ?? '').trim().toLowerCase()
	return first === '' || first.length > MAX_LENGTH ? null : first
}
