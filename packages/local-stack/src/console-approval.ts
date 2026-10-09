// The smoke approves a parked deploy the way a person does (ADR-0050 §5): signed in to the console through the real
// proxy-and-IAM handoff (`LOCAL_DEV_LOGIN` makes IAM's step non-interactive), and calling `approvals.complete` with
// the session cookie from the console's own origin. No key, so it is the same authorization and admission a human gets.

import { SESSION_COOKIE } from '@fabrika/auth-core'
import { z } from 'zod'
import { rpcResponseSchema } from './response-schemas'

const MAX_HOPS = 8
const APPROVAL_ATTEMPTS = 20
const APPROVAL_RETRY_MS = 500

/** The environment is still leased by the run that just parked; the approval is retried. */
class ConsoleConflict extends Error {}

/** One cookie jar per host, as a browser keeps it. */
class CookieJar {
	readonly #hosts = new Map<string, Map<string, string>>()

	header(url: URL): string {
		return [...(this.#hosts.get(url.host) ?? new Map<string, string>())].map(([name, value]) => `${name}=${value}`).join('; ')
	}

	remember(url: URL, response: Response): void {
		const cookies = this.#hosts.get(url.host) ?? new Map<string, string>()
		for (const setCookie of response.headers.getSetCookie()) {
			const [pair = '', ...attributes] = setCookie.split(';')
			const separator = pair.indexOf('=')
			if (separator <= 0) continue
			const name = pair.slice(0, separator).trim()
			const value = pair.slice(separator + 1).trim()
			const expired = attributes.some((attribute) => /^\s*max-age\s*=\s*0\s*$/i.test(attribute))
			if (value === '' || expired) cookies.delete(name)
			else cookies.set(name, value)
		}
		this.#hosts.set(url.host, cookies)
	}

	get(origin: string, name: string): string | undefined {
		return this.#hosts.get(new URL(origin).host)?.get(name)
	}
}

/** Follow the console's login redirects by hand and return the console host's session cookie. */
export const signInToConsole = async (consoleOrigin: string): Promise<string> => {
	const jar = new CookieJar()
	let url = new URL(`${consoleOrigin}/`)
	for (let hop = 0; hop < MAX_HOPS; hop++) {
		const response = await fetch(url, { redirect: 'manual', headers: { cookie: jar.header(url) } })
		jar.remember(url, response)
		await response.body?.cancel()
		const location = response.headers.get('location')
		if (response.status < 300 || response.status >= 400 || location === null) break
		url = new URL(location, url)
	}
	const session = jar.get(consoleOrigin, SESSION_COOKIE)
	if (session === undefined) throw new Error('signing in to the console set no session cookie')
	return `${SESSION_COOKIE}=${session}`
}

const approvalSchema = z.object({ candidateDigest: z.string().min(1), baselineDigest: z.string().min(1) })

const consoleRpc = async (consoleOrigin: string, cookie: string, method: string, input: unknown): Promise<unknown> => {
	const response = await fetch(`${consoleOrigin}/api/rpc`, {
		method: 'POST',
		redirect: 'manual',
		headers: {
			accept: 'application/json',
			'content-type': 'application/json',
			cookie,
			origin: consoleOrigin,
			'sec-fetch-site': 'same-origin',
		},
		body: JSON.stringify({ method, input }),
	})
	if (response.status === 409) throw new ConsoleConflict(`console ${method} answered 409: ${await response.text()}`)
	if (!response.ok) throw new Error(`console ${method} answered ${response.status}: ${await response.text()}`)
	const body = rpcResponseSchema.safeParse(await response.json())
	if (!body.success) throw new Error(`console ${method} was refused`)
	return body.data.result
}

/** Approve one parked run as the signed-in admin, naming the two digests the approval page shows. */
export const approveInConsole = async (consoleOrigin: string, runId: string): Promise<void> => {
	const cookie = await signInToConsole(consoleOrigin)
	const approval = approvalSchema.parse(await consoleRpc(consoleOrigin, cookie, 'approvals.get', { runId }))
	for (let attempt = 1;; attempt++) {
		try {
			await consoleRpc(consoleOrigin, cookie, 'approvals.complete', { runId, decision: 'approve', ...approval })
			return
		} catch (error) {
			if (!(error instanceof ConsoleConflict) || attempt >= APPROVAL_ATTEMPTS) throw error
			await Bun.sleep(APPROVAL_RETRY_MS)
		}
	}
}
