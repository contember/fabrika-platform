// The client a per-client bucket counts. The buckets live in the application's database (`@fabrika/db`'s
// `Admissions`), so every instance shares them. Admission is not authorization: it only bounds how much one client
// calls a public procedure.

import { CLIENT_ADDRESS_HEADER, clientAddressKey } from '@fabrika/auth-core'
import { createHash } from 'node:crypto'

/** The one client every request without a readable address shares. */
const UNKNOWN_CLIENT = 'unknown'

/**
 * The bucket of the client the proxy saw. Only `X-Fabrika-Client-Ip` is read: the proxy deletes it and sets it from
 * the connection on every request, and the proxy secret proves the request came through it. A forwarding header a
 * client can write (`X-Forwarded-For`, `CF-Connecting-IP`) is never read. The address is kept as its digest.
 */
export function clientBucket(request: Request): string {
	const key = clientAddressKey(request.headers.get(CLIENT_ADDRESS_HEADER)) ?? UNKNOWN_CLIENT
	return `client:${createHash('sha256').update(key).digest('hex')}`
}
