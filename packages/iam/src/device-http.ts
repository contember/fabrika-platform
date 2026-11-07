import { readBoundedText } from './bounded-body'
import { cancelDeviceAuthorization, exchangeDeviceAuthorization, pollDeviceAuthorization, startDeviceAuthorization } from './device'
import { parseJsonOrNull } from './json'
import type { Services } from './services'

export async function handleDeviceAuthorization(
	request: Request,
	services: Services,
	clientAddress: string | null,
	requestId: string,
): Promise<Response> {
	const headers = { 'cache-control': 'no-store' }
	if (request.method !== 'POST') return Response.json({ error: 'method not allowed' }, { status: 405, headers: { ...headers, allow: 'POST' } })
	const body = await readDeviceJson(request)
	if (body === null) return Response.json({ error: 'invalid JSON body' }, { status: 400, headers })
	try {
		switch (new URL(request.url).pathname) {
			case '/auth/device/start':
				return Response.json(await startDeviceAuthorization(services, body, clientAddress), { headers })
			case '/auth/device/poll':
				return Response.json(await pollDeviceAuthorization(services, body), { headers })
			case '/auth/device/cancel':
				return Response.json(await cancelDeviceAuthorization(services, body), { headers })
			case '/auth/device/exchange':
				return Response.json(await exchangeDeviceAuthorization(services, body, requestId), { headers })
			default:
				return Response.json({ error: 'not found' }, { status: 404, headers })
		}
	} catch {
		console.error('Device authorization storage unavailable')
		return Response.json({ error: 'unavailable' }, { status: 503, headers })
	}
}

async function readDeviceJson(request: Request): Promise<unknown> {
	if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || !request.body) return null
	const body = await readBoundedText(request, 16_384)
	return body.ok ? parseJsonOrNull(body.text) : null
}
