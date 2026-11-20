// Read by credentialed-fetch.test.ts: lines 5, 7 and 9 send a credential a followed redirect would carry along.
declare const key: string
declare const send: (request: Request) => Promise<Response>
export async function requests(doFetch: typeof fetch): Promise<void> {
	await fetch('https://api.test', { headers: { authorization: `Bearer ${key}` } })
	await fetch('https://api.test', { headers: { authorization: `Bearer ${key}` }, redirect: 'manual' })
	await doFetch('https://api.test', { method: 'POST', headers: { 'x-api-key': key }, body: '{}' })
	await doFetch('https://api.test', { headers: { accept: 'application/json' } })
	await send(new Request('https://api.test', { headers: { 'X-Service-Secret': key } }))
	await fetch('https://api.test', { ...{ redirect: 'error' as const }, headers: { authorization: key } })
}
