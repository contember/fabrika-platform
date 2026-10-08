// The share SPA's key. The framework serves the SPA's document with a bootstrap that runs before any other script:
// it takes the key out of the URL fragment (`/s/#<key>`), removes the fragment, and keeps the key in a closure.

import { SHARE_KEY_GLOBAL } from '../contract/defaults'

/** The key the share link carried, or `null` outside a share SPA or when the link had none. */
export function shareKey(): string | null {
	const read: unknown = Reflect.get(globalThis, SHARE_KEY_GLOBAL)
	if (typeof read !== 'function') {
		return null
	}
	const key: unknown = read()
	return typeof key === 'string' && key !== '' ? key : null
}
