import type { AppGates } from '@fabrika/auth'
import { exampleAppId } from './fabrika.schema'

/**
 * The example app's per-path gates, declared in code and enforced by the shared proxy authorizer
 * before the private application Worker runs.
 *
 * Where `fabrika.schema.ts` declares the app's authz vocabulary, this declares WHICH credential
 * KIND each path requires. The Cloudflare composition embeds them in the proxy manifest; there is
 * no separate gate endpoint. Array order is the precedence (first matching+satisfiable rule wins);
 * a path matching no rule is denied.
 */
export const exampleGates: AppGates = {
	rules: [
		// Public carve-out.
		{ path: '/public/*', kind: 'public' },
		// A machine `px_` key (Authorization: Bearer) OR a logged-in human.
		{ path: '/*', kind: 'service' },
		{ path: '/*', kind: 'human' },
	],
}

// Re-exported so callers read one source for the app id.
export { exampleAppId }
