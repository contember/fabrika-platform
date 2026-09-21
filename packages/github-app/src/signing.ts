import { configurationError } from './errors'

export async function signAppJwt(appId: string, privateKey: CryptoKey, clock: () => number): Promise<string> {
	const now = Math.floor(clock() / 1000)
	const header = { alg: 'RS256', typ: 'JWT' }
	const payload = { iat: now - 30, exp: now + 9 * 60, iss: appId }
	const encode = (value: unknown): string => base64url(utf8(JSON.stringify(value)))
	const signingInput = `${encode(header)}.${encode(payload)}`
	try {
		const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, utf8(signingInput))
		return `${signingInput}.${base64url(new Uint8Array(signature))}`
	} catch {
		throw configurationError()
	}
}

/** Convert a GitHub App PKCS1 or PKCS8 PEM key into PKCS8 DER for WebCrypto. */
export function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
	const pkcs1 = /^-----BEGIN RSA PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END RSA PRIVATE KEY-----\s*$/.exec(pem)
	const pkcs8 = /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PRIVATE KEY-----\s*$/.exec(pem)
	const match = pkcs1 ?? pkcs8
	const body = match?.[1]
	if (body === undefined) {
		throw configurationError()
	}
	let binary: string
	try {
		binary = atob(body.replace(/\s+/g, ''))
	} catch {
		throw configurationError()
	}
	if (binary.length === 0 || binary.charCodeAt(0) !== 0x30) {
		throw configurationError()
	}
	const der = new Uint8Array(binary.length)
	for (let index = 0; index < binary.length; index++) {
		der[index] = binary.charCodeAt(index)
	}
	return pkcs1 === null ? der : wrapPkcs1AsPkcs8(der)
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
	const encoded = new TextEncoder().encode(text)
	const buffer = new ArrayBuffer(encoded.byteLength)
	const view = new Uint8Array(buffer)
	view.set(encoded)
	return view
}

function base64url(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function derTlv(tag: number, content: Uint8Array): Uint8Array<ArrayBuffer> {
	let lengthBytes: number[]
	if (content.length < 0x80) {
		lengthBytes = [content.length]
	} else {
		const big: number[] = []
		let length = content.length
		while (length > 0) {
			big.unshift(length & 0xff)
			length >>= 8
		}
		lengthBytes = [0x80 | big.length, ...big]
	}
	const out = new Uint8Array(1 + lengthBytes.length + content.length)
	out[0] = tag
	out.set(lengthBytes, 1)
	out.set(content, 1 + lengthBytes.length)
	return out
}

function wrapPkcs1AsPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
	const version = new Uint8Array([0x02, 0x01, 0x00])
	const algorithmId = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00])
	const privateKey = derTlv(0x04, pkcs1)
	const inner = new Uint8Array(version.length + algorithmId.length + privateKey.length)
	inner.set(version, 0)
	inner.set(algorithmId, version.length)
	inner.set(privateKey, version.length + algorithmId.length)
	return derTlv(0x30, inner)
}
