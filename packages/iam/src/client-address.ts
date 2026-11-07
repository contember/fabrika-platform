/**
 * The client coordinate a per-client abuse limit is keyed on — and, more importantly, the rule about
 * where it may come from.
 *
 * IAM cannot derive it. Behind a balancer its socket peer IS the balancer, and a forwarding header the
 * caller can write is worse than no limiter because it looks like protection — backlog 21 and 49
 * refused to build on one twice before this shipped
 * ([sprint](../../../docs/archive/sprint-2026-08-05-auth-track-closeout.md)). So IAM does not
 * choose a header: the COMPOSITION ROOT names the one header its own ingress guarantees, and shared
 * code reads that one and nothing else. Naming none is a supported configuration — it means this
 * installation cannot see its clients, and the account and deployment-wide buckets carry the load
 * alone, exactly as they did before.
 *
 * The two roots and what they name:
 *
 *   - `src/index.ts` (Cloudflare) — `CF-Connecting-IP`. IAM's Worker holds its own Custom Domain, so
 *     it is reached through Cloudflare's edge, which writes that header and replaces a caller's.
 *   - `src/node/server.ts` (Bun/Zerops) — none. The Caddy proxy in front of it writes `CLIENT_ADDRESS_HEADER`, but
 *     behind the Zerops balancer that value is the balancer for every client
 *     ([platform facts](../../../docs/reference/zerops-platform.md#public-access)), so one bucket would hold the
 *     whole installation. Without the proxy's secret a request still keys on `UNPROVEN_CLIENT_ADDRESS`
 *     (`src/proxy-proof.ts`).
 *
 * A composition names a header only when its ingress overwrites it with the client's own address. That is the whole
 * invariant.
 */

import { clientAddressKey } from '@fabrika/auth-core'

/**
 * Read the coordinate, or `null` when this composition cannot see one or the value is no IP address. An IPv6 client
 * counts by its /64, and only the first value counts (`clientAddressKey`).
 */
export function readClientAddress(request: Request, header: string | undefined): string | null {
	if (header === undefined || header === '') {
		return null
	}
	return clientAddressKey(request.headers.get(header))
}
