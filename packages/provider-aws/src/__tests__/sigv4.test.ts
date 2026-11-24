// The SigV4 signer against known answers. Each vector's request, canonical request and signature come from AWS's
// Signature Version 4 test suite as published in awslabs/aws-c-auth (`tests/aws-signing-test-suite/v4/<case>/`),
// Copyright Amazon.com, Inc. or its affiliates, licensed under the Apache License, Version 2.0, whose text is
// `aws-signing-test-suite.LICENSE` beside this file. Every case signs with
// the suite's context: the key pair below, region `us-east-1`, service `service`, at 2015-08-30T12:36:00Z, header
// signing, path normalization on. A case whose path needs encoding (`get-utf8`, `get-space-normalized`) is not taken:
// this signer refuses such a path instead (see the refusals below).

import { describe, expect, test } from 'bun:test'
import {
	canonicalRequest,
	presignGet,
	type SignableRequest,
	type SigningCredentials,
	type SigningScope,
	signRequest,
	stringToSign,
} from '../aws/sigv4'

const credentials: SigningCredentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }
const scope: SigningScope = { region: 'us-east-1', service: 'service' }
const at = new Date('2015-08-30T12:36:00Z')
const origin = 'https://example.amazonaws.com'
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const FORM_SHA256 = '9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e'
const DATE = 'x-amz-date:20150830T123600Z'
const HOST = 'host:example.amazonaws.com'
const UNRESERVED = '-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const SESSION_TOKEN = '6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267'
const STS_TOKEN =
	'AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA=='

interface Vector {
	readonly name: string
	readonly request: Omit<SignableRequest, 'origin'>
	readonly sessionToken?: string
	readonly signBody?: true
	/** The suite's `header-canonical-request.txt`, one array item per line. */
	readonly canonical: readonly string[]
	readonly signedHeaders: string
	/** The suite's `header-signature.txt`. */
	readonly signature: string
}

const vectors: readonly Vector[] = [
	{
		name: 'get-vanilla',
		request: { method: 'GET', path: '/' },
		canonical: ['GET', '/', '', HOST, DATE, '', 'host;x-amz-date', EMPTY_SHA256],
		signedHeaders: 'host;x-amz-date',
		signature: '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
	},
	{
		name: 'post-vanilla',
		request: { method: 'POST', path: '/' },
		canonical: ['POST', '/', '', HOST, DATE, '', 'host;x-amz-date', EMPTY_SHA256],
		signedHeaders: 'host;x-amz-date',
		signature: '5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b',
	},
	{
		name: 'get-vanilla-with-session-token',
		request: { method: 'GET', path: '/' },
		sessionToken: SESSION_TOKEN,
		canonical: ['GET', '/', '', HOST, DATE, `x-amz-security-token:${SESSION_TOKEN}`, '', 'host;x-amz-date;x-amz-security-token', EMPTY_SHA256],
		signedHeaders: 'host;x-amz-date;x-amz-security-token',
		signature: '07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8',
	},
	{
		name: 'post-sts-header-before',
		request: { method: 'POST', path: '/' },
		sessionToken: STS_TOKEN,
		canonical: ['POST', '/', '', HOST, DATE, `x-amz-security-token:${STS_TOKEN}`, '', 'host;x-amz-date;x-amz-security-token', EMPTY_SHA256],
		signedHeaders: 'host;x-amz-date;x-amz-security-token',
		signature: '85d96828115b5dc0cfc3bd16ad9e210dd772bbebba041836c64533a82be05ead',
	},
	{
		name: 'post-x-www-form-urlencoded',
		request: {
			method: 'POST',
			path: '/',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': '13' },
			body: 'Param1=value1',
		},
		signBody: true,
		canonical: [
			'POST',
			'/',
			'',
			'content-length:13',
			'content-type:application/x-www-form-urlencoded',
			HOST,
			`x-amz-content-sha256:${FORM_SHA256}`,
			DATE,
			'',
			'content-length;content-type;host;x-amz-content-sha256;x-amz-date',
			FORM_SHA256,
		],
		signedHeaders: 'content-length;content-type;host;x-amz-content-sha256;x-amz-date',
		signature: 'd3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b',
	},
	{
		name: 'post-x-www-form-urlencoded-parameters',
		request: {
			method: 'POST',
			path: '/',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', 'Content-Length': '13' },
			body: new TextEncoder().encode('Param1=value1'),
		},
		signBody: true,
		canonical: [
			'POST',
			'/',
			'',
			'content-length:13',
			'content-type:application/x-www-form-urlencoded; charset=utf-8',
			HOST,
			`x-amz-content-sha256:${FORM_SHA256}`,
			DATE,
			'',
			'content-length;content-type;host;x-amz-content-sha256;x-amz-date',
			FORM_SHA256,
		],
		signedHeaders: 'content-length;content-type;host;x-amz-content-sha256;x-amz-date',
		signature: '328d1b9eaadca9f5818ef05e8392801e091653bafec24fcab71e7344e7f51422',
	},
	{
		name: 'get-header-value-trim',
		request: { method: 'GET', path: '/', headers: { 'My-Header1': ' value1', 'My-Header2': ' "a   b   c"' } },
		canonical: ['GET', '/', '', HOST, 'my-header1:value1', 'my-header2:"a b c"', DATE, '', 'host;my-header1;my-header2;x-amz-date', EMPTY_SHA256],
		signedHeaders: 'host;my-header1;my-header2;x-amz-date',
		signature: 'acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736',
	},
	{
		name: 'post-header-key-sort',
		request: { method: 'POST', path: '/', headers: { 'My-Header1': 'value1' } },
		canonical: ['POST', '/', '', HOST, 'my-header1:value1', DATE, '', 'host;my-header1;x-amz-date', EMPTY_SHA256],
		signedHeaders: 'host;my-header1;x-amz-date',
		signature: 'c5410059b04c1ee005303aed430f6e6645f61f4dc9e1461ec8f8916fdf18852c',
	},
	{
		name: 'post-header-value-case',
		request: { method: 'POST', path: '/', headers: { 'My-Header1': 'VALUE1' } },
		canonical: ['POST', '/', '', HOST, 'my-header1:VALUE1', DATE, '', 'host;my-header1;x-amz-date', EMPTY_SHA256],
		signedHeaders: 'host;my-header1;x-amz-date',
		signature: 'cdbc9802e29d2942e5e10b5bccfdd67c5f22c7c4e8ae67b53629efa58b974b7d',
	},
	{
		name: 'get-unreserved',
		request: { method: 'GET', path: `/${UNRESERVED}` },
		canonical: ['GET', `/${UNRESERVED}`, '', HOST, DATE, '', 'host;x-amz-date', EMPTY_SHA256],
		signedHeaders: 'host;x-amz-date',
		signature: '07ef7494c76fa4850883e2b006601f940f8a34d404d0cfa977f52a65bbf5f24f',
	},
	{
		name: 'get-vanilla-query-order-key-case',
		request: { method: 'GET', path: '/', query: [['Param2', 'value2'], ['Param1', 'value1']] },
		canonical: ['GET', '/', 'Param1=value1&Param2=value2', HOST, DATE, '', 'host;x-amz-date', EMPTY_SHA256],
		signedHeaders: 'host;x-amz-date',
		signature: 'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500',
	},
	{
		name: 'get-vanilla-empty-query-key',
		request: { method: 'GET', path: '/', query: [['Param1', 'value1']] },
		canonical: ['GET', '/', 'Param1=value1', HOST, DATE, '', 'host;x-amz-date', EMPTY_SHA256],
		signedHeaders: 'host;x-amz-date',
		signature: 'a67d582fa61cc504c4bae71f336f98b97f1ea3c7a6bfe1b6e45aec72011b9aeb',
	},
	{
		name: 'get-vanilla-query-unreserved',
		request: { method: 'GET', path: '/', query: [[UNRESERVED, UNRESERVED]] },
		canonical: ['GET', '/', `${UNRESERVED}=${UNRESERVED}`, HOST, DATE, '', 'host;x-amz-date', EMPTY_SHA256],
		signedHeaders: 'host;x-amz-date',
		signature: '9c3e54bfcdf0b19771a7f523ee5669cdf59bc7cc0884027167c21bb143a40197',
	},
	{
		name: 'get-vanilla-utf8-query',
		request: { method: 'GET', path: '/', query: [['ሴ', 'bar']] },
		canonical: ['GET', '/', '%E1%88%B4=bar', HOST, DATE, '', 'host;x-amz-date', EMPTY_SHA256],
		signedHeaders: 'host;x-amz-date',
		signature: '2cdec8eed098649ff3a119c94853b13c643bcf08f8b0a1d91e12c9027818dd04',
	},
	{
		name: 'post-vanilla-query',
		request: { method: 'POST', path: '/', query: [['Param1', 'value1']] },
		canonical: ['POST', '/', 'Param1=value1', HOST, DATE, '', 'host;x-amz-date', EMPTY_SHA256],
		signedHeaders: 'host;x-amz-date',
		signature: '28038455d6de14eafc1f9222cf5aa6f1a96197d7deb8263271d420d138af7f11',
	},
]

/** The message `signRequest` refuses `request` with. */
async function refusal(request: SignableRequest, signer: SigningCredentials = credentials, signerScope: SigningScope = scope): Promise<string> {
	try {
		await signRequest(request, signer, signerScope, at)
	} catch (error) {
		return error instanceof Error ? error.message : ''
	}
	throw new Error('the request was signed')
}

describe('SigV4 known answers', () => {
	for (const vector of vectors) {
		test(vector.name, async () => {
			const signer: SigningCredentials = vector.sessionToken === undefined ? credentials : { ...credentials, sessionToken: vector.sessionToken }
			const signed = await signRequest({ ...vector.request, origin }, signer, scope, at, { bodyDigestHeader: vector.signBody === true })
			expect(signed.headers.authorization).toBe(
				`AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=${vector.signedHeaders}, Signature=${vector.signature}`,
			)
			// The canonical request of exactly the headers sent (host is the URL's), against the suite's own text.
			const sent = Object.fromEntries(Object.entries(signed.headers).filter(([name]) => name !== 'authorization'))
			const bodyDigest = vector.signBody === true ? FORM_SHA256 : EMPTY_SHA256
			const canonical = canonicalRequest(vector.request.method, vector.request.path, vector.request.query ?? [], {
				...sent,
				host: 'example.amazonaws.com',
			}, bodyDigest)
			expect(canonical.text).toBe(vector.canonical.join('\n'))
		})
	}

	test("get-vanilla's string to sign", async () => {
		const canonical = ['GET', '/', '', HOST, DATE, '', 'host;x-amz-date', EMPTY_SHA256].join('\n')
		expect(await stringToSign('20150830T123600Z', scope, canonical)).toBe(
			[
				'AWS4-HMAC-SHA256',
				'20150830T123600Z',
				'20150830/us-east-1/service/aws4_request',
				'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
			].join('\n'),
		)
	})
})

describe('signRequest', () => {
	test('answers the URL with its canonical query and the headers to send, never host', async () => {
		const signed = await signRequest({ method: 'GET', origin, path: '/', query: [['b', 'two words'], ['a', 'x']] }, credentials, scope, at)
		expect(signed.url).toBe('https://example.amazonaws.com/?a=x&b=two%20words')
		expect(Object.keys(signed.headers).sort()).toEqual(['authorization', 'x-amz-date'])
		expect(signed.headers['x-amz-date']).toBe('20150830T123600Z')
	})

	test("signs a local emulator's origin with its port and its short key when allowed, and a session token as its header", async () => {
		const local = { accessKeyId: 'test', secretAccessKey: 'test', sessionToken: SESSION_TOKEN }
		const insecure = { allowInsecureOrigin: true }
		const signed = await signRequest({ method: 'POST', origin: 'http://localhost:4566', path: '/', body: '{}' }, local, scope, at, insecure)
		expect(signed.url).toBe('http://localhost:4566/')
		expect(signed.headers['x-amz-security-token']).toBe(SESSION_TOKEN)
		expect(signed.headers.authorization).toContain(
			'Credential=test/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date;x-amz-security-token,',
		)
		const other = await signRequest({ method: 'POST', origin: 'http://localhost:4567', path: '/', body: '{}' }, local, scope, at, insecure)
		expect(other.headers.authorization).not.toBe(signed.headers.authorization)
	})

	test('refuses an http: origin unless the caller allows it, whatever the host', async () => {
		for (const insecure of ['http://localhost:4566', 'http://ecs.eu-central-1.amazonaws.com']) {
			expect(await refusal({ method: 'POST', origin: insecure, path: '/' })).toContain('allowInsecureOrigin')
		}
	})

	test('signs the query as it was when called, and sends that same query', async () => {
		const query: [string, string][] = [['a', '1']]
		const pending = signRequest({ method: 'GET', origin, path: '/', query }, credentials, scope, at)
		query.push(['b', '2'])
		const signed = await pending
		const alone = await signRequest({ method: 'GET', origin, path: '/', query: [['a', '1']] }, credentials, scope, at)
		expect(signed).toEqual(alone)
		expect(signed.url).toBe('https://example.amazonaws.com/?a=1')
	})

	test('a run of spaces and tabs inside a header value signs as one space', () => {
		const headers = { host: 'example.amazonaws.com', 'my-header': ' a\t\tb  \t c ' }
		expect(canonicalRequest('GET', '/', [], headers, EMPTY_SHA256).text).toContain('\nmy-header:a b c\n')
	})

	test("a header named like an object's own property is signed as any other", async () => {
		const signed = await signRequest({ method: 'POST', origin, path: '/', headers: { constructor: 'a', toString: 'b' } }, credentials, scope, at)
		expect(signed.headers.authorization).toContain('SignedHeaders=constructor;host;tostring;x-amz-date,')
		expect(Object.entries(signed.headers)).toContainEqual(['constructor', 'a'])
	})

	test('a trailing slash is kept, and the body changes the signature', async () => {
		const a = await signRequest({ method: 'POST', origin, path: '/a/', body: '{"a":1}' }, credentials, scope, at)
		const b = await signRequest({ method: 'POST', origin, path: '/a/', body: '{"a":2}' }, credentials, scope, at)
		expect(a.url).toBe('https://example.amazonaws.com/a/')
		expect(a.headers.authorization).not.toBe(b.headers.authorization)
	})

	test('refuses a path it would have to encode or normalize, rather than sign another path than it sends', async () => {
		for (const path of ['/ሴ', '/example space/', '/a/../b', '/./a', '//a', '/a//b', 'a', '/%41']) {
			expect(await refusal({ method: 'GET', origin, path })).toContain('path')
		}
	})

	test('refuses a header the signer owns, a repeated one, a line break and a name that is not a token, quoting no value', async () => {
		const cases: readonly { readonly headers: Readonly<Record<string, string>>; readonly part: string }[] = [
			{ headers: { Authorization: 'secret-auth' }, part: 'authorization' },
			{ headers: { Host: 'evil.example' }, part: 'host' },
			{ headers: { 'X-Amz-Security-Token': 'secret-token' }, part: 'x-amz-security-token' },
			{ headers: { 'X-Amz-Target': 'a', 'x-amz-target': 'b-secret' }, part: 'twice' },
			{ headers: { 'X-Injected': 'a\r\nx-amz-date: secret-date' }, part: 'control character' },
			{ headers: { 'bad name': 'secret-value' }, part: 'token' },
		]
		for (const { headers, part } of cases) {
			const message = await refusal({ method: 'POST', origin, path: '/', headers })
			expect(message).toContain(part)
			expect(message).not.toContain('secret')
		}
	})

	test('refuses an origin that is not a bare http(s) origin', async () => {
		for (
			const bad of ['https://example.amazonaws.com/', 'https://user:pw@example.amazonaws.com', 'ftp://example.amazonaws.com', 'example.amazonaws.com']
		) {
			expect(await refusal({ method: 'GET', origin: bad, path: '/' })).toContain('origin')
		}
	})

	test('refuses credentials and a scope of another form, quoting neither', async () => {
		const secret = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
		const badKey = await refusal({ method: 'GET', origin, path: '/' }, { accessKeyId: 'akid-secret', secretAccessKey: secret })
		expect(badKey).toContain('access key id')
		expect(badKey).not.toContain('akid-secret')
		expect(await refusal({ method: 'GET', origin, path: '/' }, { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: '' })).toContain('secret access key')
		const badToken = await refusal({ method: 'GET', origin, path: '/' }, { ...credentials, sessionToken: 'tok\nsecret' })
		expect(badToken).toContain('session token')
		expect(badToken).not.toContain('secret')
		expect(await refusal({ method: 'GET', origin, path: '/' }, { ...credentials, sessionToken: '' })).toContain('session token is empty')
		expect(await refusal({ method: 'GET', origin, path: '/' }, credentials, { region: 'US-EAST-1', service: 'service' })).toContain('region')
		const query = await refusal({ method: 'GET', origin, path: '/', query: [['\ud800', 'x']] })
		expect(query).toContain('query')
	})
})

describe('presignGet', () => {
	// AWS's published example of a presigned GET ("Authenticating Requests: Using Query Parameters", S3's API reference).
	const example = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }
	const s3 = { region: 'us-east-1', service: 's3' }
	const day = new Date('2013-05-24T00:00:00Z')

	test("signs AWS's published example to its known answer", async () => {
		expect(await presignGet({ origin: 'https://examplebucket.s3.amazonaws.com', path: '/test.txt' }, example, s3, day, 86400)).toBe(
			'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256'
				+ '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request'
				+ '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host'
				+ '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
		)
	})

	test('carries a session token in the signed query, and keeps the bucket in the host', async () => {
		const url = new URL(
			await presignGet(
				{ origin: 'https://fabrika-apps-sources.s3.eu-central-1.amazonaws.com', path: '/sources/run-1/source.tar.gz' },
				{ ...example, sessionToken: 'token/with+chars' },
				{ region: 'eu-central-1', service: 's3' },
				day,
				900,
			),
		)
		expect(url.origin).toBe('https://fabrika-apps-sources.s3.eu-central-1.amazonaws.com')
		expect(url.pathname).toBe('/sources/run-1/source.tar.gz')
		expect(url.searchParams.get('X-Amz-Security-Token')).toBe('token/with+chars')
		expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
		expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
		// The signature is the last parameter, after the signed query.
		expect(url.search.endsWith(`&X-Amz-Signature=${url.searchParams.get('X-Amz-Signature') ?? ''}`)).toBe(true)
	})

	test('refuses an expiry, a path or an origin it does not sign', async () => {
		const origin = 'https://examplebucket.s3.amazonaws.com'
		const refused = (request: { origin: string; path: string }, expires: number) =>
			presignGet(request, example, s3, day, expires).then(() => '', (error: unknown) => String(error))
		expect(await refused({ origin, path: '/test.txt' }, 0)).toContain('expiry')
		expect(await refused({ origin, path: '/test.txt' }, 604801)).toContain('expiry')
		expect(await refused({ origin, path: '/a/../b' }, 60)).toContain('path')
		expect(await refused({ origin: 'http://examplebucket.s3.amazonaws.com', path: '/test.txt' }, 60)).toContain('origin')
	})
})
