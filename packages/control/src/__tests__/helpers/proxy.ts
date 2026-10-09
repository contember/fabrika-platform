// The console behind the real Cloudflare proxy Worker handler: the same decision, hop and header strips a deployed
// `vozka-proxy` runs, in front of whatever upstream the test supplies. The IAM it asks mints the suite's own tokens.

import type { AppGates, ExchangeAuthCodeResult, MintFromKeyResult, MintTokenResult } from '@fabrika/auth-core'
import { silentLogger } from '@fabrika/proxy-core'
import type { InstallationProxyTable, OAuthProtectedResource } from '@fabrika/proxy-core/manifest'
import { createCloudflareProxyHandler } from '../../../../provider-cloudflare/src/proxy-worker'
import { TEST_ISSUER, testIamBinding } from './tokens'

export const CONSOLE_HOST = 'control.test'
export const CONSOLE_ORIGIN = `https://${CONSOLE_HOST}`

/** What a fixture's IAM answers: the session cookie's token, and each `px_` key's. */
export interface ProxyIam {
	readonly session?: string
	readonly keys?: Readonly<Record<string, string>>
}

export interface ConsoleProxyOptions {
	/** The table a new proxy publishes (`serviceProxyTable`), or the gates an old one carried. */
	readonly access: { readonly table: InstallationProxyTable } | { readonly gates: AppGates }
	readonly oauthResources?: readonly OAuthProtectedResource[]
	readonly iam?: ProxyIam
	readonly upstream: (request: Request) => Promise<Response>
}

const future = () => Math.floor(Date.now() / 1000) + 300

/** A request through the console's proxy: a 2xx from the upstream, or the proxy's own refusal, bounce or challenge. */
export function consoleBehindProxy(options: ConsoleProxyOptions): (request: Request) => Promise<Response> {
	const access = 'table' in options.access ? options.access.table : { gates: options.access.gates }
	const manifest = {
		apps: [{
			id: 'vozka',
			hosts: [CONSOLE_HOST],
			upstream: 'APP',
			scheme: 'https',
			...access,
			...(options.oauthResources === undefined ? {} : { oauthResources: [...options.oauthResources] }),
		}],
	}
	const iam = options.iam ?? {}
	const gateway = {
		mintToken: (): Promise<MintTokenResult> =>
			Promise.resolve(iam.session === undefined ? { ok: false, reason: 'no_session' } : { ok: true, token: iam.session, expiresAt: future() }),
		mintFromKey: (input: { readonly key: string }): Promise<MintFromKeyResult> => {
			const token = iam.keys?.[input.key]
			return Promise.resolve(token === undefined ? { ok: false, reason: 'invalid_key' } : { ok: true, token, expiresAt: future() })
		},
		exchangeAuthCode: (): Promise<ExchangeAuthCodeResult> => Promise.resolve({ ok: false, reason: 'invalid_code' }),
		getJwks: () => testIamBinding.getJwks(),
	}
	return createCloudflareProxyHandler({
		IAM: gateway,
		FABRIKA_PROXY_MANIFEST_JSON: JSON.stringify(manifest),
		FABRIKA_IAM_ISSUER: TEST_ISSUER,
		APP: { fetch: options.upstream },
	}, silentLogger)
}
