// Read by credentialed-fetch.test.ts. Each request ends with `// flagged` when the scan must report it (a followed
// redirect would carry the credential along), or with `// passes:` and the reason it must not.
declare const key: string
declare const send: (request: Request) => Promise<Response>
export async function requests(doFetch: typeof fetch): Promise<void> {
	await fetch('https://api.test', { headers: { authorization: `Bearer ${key}` } }) // flagged
	await fetch('https://api.test', { headers: { authorization: `Bearer ${key}` }, redirect: 'manual' }) // passes: says what a redirect does
	await doFetch('https://api.test', { method: 'POST', headers: { 'x-api-key': key }, body: '{}' }) // flagged
	await doFetch('https://api.test', { headers: { accept: 'application/json' } }) // passes: no credential
	await send(new Request('https://api.test', { headers: { 'X-Service-Secret': key } })) // flagged
	await fetch('https://api.test', { ...{ redirect: 'error' as const }, headers: { authorization: key } }) // passes: a spread is not read
	const headers = new Headers({ accept: 'application/json' })
	headers.set('authorization', `Bearer ${key}`)
	const fetchImpl = doFetch
	await fetchImpl('https://api.test', { method: 'POST', headers, body: '{}' }) // flagged
	await doFetch('https://api.test', { headers: headers }) // flagged
	await doFetch('https://api.test', { headers, redirect: 'manual' }) // passes: says what a redirect does
}
export async function record(doFetch: typeof fetch): Promise<void> {
	const headers: Record<string, string> = { authorization: `Bearer ${key}`, accept: 'application/json' }
	await doFetch('https://api.test', { method: 'POST', headers, body: '{}' }) // flagged
	await doFetch('https://api.test', { method: 'POST', headers, body: '{}', redirect: 'manual' }) // passes: says what a redirect does
}
export async function plain(doFetch: typeof fetch): Promise<void> {
	const headers = new Headers({ accept: 'application/json' })
	await doFetch('https://api.test', { headers }) // passes: this function sets no credential on these headers
}
