// Read by credentialed-fetch.test.ts: lines 5, 7, 9, 14 and 15 send a credential a followed redirect would carry along.
declare const key: string
declare const send: (request: Request) => Promise<Response>
export async function requests(doFetch: typeof fetch): Promise<void> {
	await fetch('https://api.test', { headers: { authorization: `Bearer ${key}` } })
	await fetch('https://api.test', { headers: { authorization: `Bearer ${key}` }, redirect: 'manual' })
	await doFetch('https://api.test', { method: 'POST', headers: { 'x-api-key': key }, body: '{}' })
	await doFetch('https://api.test', { headers: { accept: 'application/json' } })
	await send(new Request('https://api.test', { headers: { 'X-Service-Secret': key } }))
	await fetch('https://api.test', { ...{ redirect: 'error' as const }, headers: { authorization: key } })
	const headers = new Headers({ accept: 'application/json' })
	headers.set('authorization', `Bearer ${key}`)
	const fetchImpl = doFetch
	await fetchImpl('https://api.test', { method: 'POST', headers, body: '{}' })
	await doFetch('https://api.test', { headers: headers })
	await doFetch('https://api.test', { headers, redirect: 'manual' })
}
export async function plain(doFetch: typeof fetch): Promise<void> {
	const headers = new Headers({ accept: 'application/json' })
	await doFetch('https://api.test', { headers })
}
