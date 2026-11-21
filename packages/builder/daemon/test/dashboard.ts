import { BUILDER_CLI_TOKEN_HEADER, builderDaemonUrl } from '../../shared/urls'
import type { RunningDaemon } from '../src/index'

/** A browser signed in to the dashboard: its cookie, as a `Cookie` header value, and `fetch` that sends it. */
export interface Dashboard {
	cookie: string
	fetch: (input: string, init?: RequestInit) => Promise<Response>
}

/** Signs a browser in as a user does, through a link the CLI asked the daemon for. */
export async function signIn(daemon: RunningDaemon): Promise<Dashboard> {
	const base = builderDaemonUrl(daemon.port)
	const issued = await fetch(`${base}/api/session/sign-in/link`, { method: 'POST', headers: { [BUILDER_CLI_TOKEN_HEADER]: daemon.cliAuthToken } })
	const body: unknown = await issued.json()
	if (typeof body !== 'object' || body === null || !('signInUrl' in body) || typeof body.signInUrl !== 'string') {
		throw new Error(`The daemon issued no link (HTTP ${issued.status})`)
	}
	const cookie = (await fetch(body.signInUrl)).headers.get('Set-Cookie')?.split(';')[0]
	if (cookie === undefined) throw new Error('The link set no cookie')
	return {
		cookie,
		fetch: (input, init = {}) => {
			const headers = new Headers(init.headers)
			headers.set('Cookie', cookie)
			return fetch(input, { ...init, headers })
		},
	}
}
