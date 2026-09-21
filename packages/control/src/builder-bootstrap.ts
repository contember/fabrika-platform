import {
	BUILDER_APPROVAL_STORAGE_KEY,
	BUILDER_AUTHORIZE_PATH,
	parseBuilderApprovalState,
	parseBuilderInstallationDiscovery,
	parseBuilderPublicOrigin,
} from '@fabrika/control-contract'
import type { IamEnv } from './iam'
import { controlPublicOrigin } from './iam'

const DISCOVERY_PATH = '/.well-known/fabrika-builder'
const CONNECT_PATH = '/builder/connect'

export function builderPublicResponse(request: Request, env: IamEnv, provider: string): Response | null {
	const url = new URL(request.url)
	if (url.pathname !== DISCOVERY_PATH && url.pathname !== CONNECT_PATH) return null
	if (request.method !== 'GET') return response('method not allowed', 405, { allow: 'GET' })
	if (url.search !== '' || url.hash !== '') return response('invalid builder URL', 400)
	const controlOrigin = parseBuilderPublicOrigin(controlPublicOrigin(env))
	if (controlOrigin === null) return response('builder connection unavailable', 503)
	if (url.pathname === DISCOVERY_PATH) {
		const discovery = parseBuilderInstallationDiscovery({ version: 1, controlOrigin, iamIssuer: env.FABRIKA_IAM_ISSUER, provider })
		if (discovery === null) return response('builder connection unavailable', 503)
		return response(JSON.stringify(discovery), 200, { 'content-type': 'application/json; charset=utf-8' })
	}
	const nonce = crypto.randomUUID().replaceAll('-', '')
	const script = `const parseState = ${parseBuilderApprovalState.toString()};\n(${captureApproval.toString()})(${JSON.stringify(controlOrigin)}, ${
		JSON.stringify(BUILDER_APPROVAL_STORAGE_KEY)
	}, ${JSON.stringify(BUILDER_AUTHORIZE_PATH)}, parseState);`
	return response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Connect builder</title><script nonce="${nonce}">${script}</script></head><body><p id="status">The connection could not be opened. Start a new connection from your local builder.</p></body></html>`,
		200,
		{
			'content-type': 'text/html; charset=utf-8',
			'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
		},
	)
}

/** Serialized into the page: keep all dependencies explicit and strip the proof before any navigation. */
function captureApproval(
	expectedOrigin: string,
	storageKey: string,
	authorizePath: string,
	parseState: typeof parseBuilderApprovalState,
): void {
	const fragment = window.location.hash
	const search = window.location.search
	try {
		window.history.replaceState(null, '', '/builder/connect')
		window.sessionStorage.removeItem(storageKey)
		if (window.location.origin !== expectedOrigin || search !== '' || !fragment.startsWith('#')) return
		const params = new URLSearchParams(fragment.slice(1))
		if (params.size !== 3 || [...params.keys()].some((key) => !['attempt', 'approval', 'expires'].includes(key))) return
		if (['attempt', 'approval', 'expires'].some((key) => params.getAll(key).length !== 1)) return
		const expires = params.get('expires')
		if (expires === null || !/^[0-9]{1,10}$/.test(expires)) return
		const state = parseState({ attemptId: params.get('attempt'), approvalVerifier: params.get('approval'), expiresAt: Number(expires) })
		if (state === null) return
		const serialized = JSON.stringify(state)
		window.sessionStorage.setItem(storageKey, serialized)
		if (window.sessionStorage.getItem(storageKey) !== serialized) throw new Error('storage unavailable')
		window.location.replace(authorizePath)
	} catch {
		try {
			window.sessionStorage.removeItem(storageKey)
		} catch {
			// A failed storage backend must never fall back to a credential-bearing redirect.
		}
	}
}

function response(body: string, status: number, extra: Record<string, string> = {}): Response {
	return new Response(body, {
		status,
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store',
			'referrer-policy': 'no-referrer',
			'x-content-type-options': 'nosniff',
			...extra,
		},
	})
}
