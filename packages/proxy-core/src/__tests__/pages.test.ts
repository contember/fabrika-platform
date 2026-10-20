/**
 * A person whose browser navigates to an address the proxy refuses reads a page; every other caller reads the short
 * text it always read. The page names no deny reason, and a download endpoint's refusal stays the text, because the
 * file treatment makes every answer of a download an attachment.
 */

import { describe, expect, test } from 'bun:test'
import { appFileTreatment, headerPolicy, NO_CSP_ORIGINS } from '../headers'
import { errorPage, type ErrorPageStatus, isPageNavigation } from '../pages'
import { createVerifyService } from '../service'
import { anonymousRow, contractAppWith, endpointRow, FakeIam, ISSUER, verifyRequest } from './helpers'

const ME = endpointRow({
	id: 'api.me',
	kind: 'query',
	method: 'GET',
	path: '/api/me',
	callers: ['human'],
	requirement: { kind: 'member' },
	admission: null,
})
const EXPORT = endpointRow({
	id: 'api.export',
	kind: 'query',
	method: 'GET',
	path: '/api/export',
	callers: ['machine'],
	requirement: { kind: 'member' },
	admission: null,
})
const DOWNLOAD = endpointRow({
	id: 'files.avatar.download',
	kind: 'download',
	method: 'GET',
	path: '/api/files.avatar/:fileId',
	callers: ['human'],
	requirement: { kind: 'action', action: 'files.read', access: { form: 'on', dimension: 'file', from: 'fileId' } },
	admission: null,
})
const HEALTH = anonymousRow({ id: 'health', kind: 'health', method: 'GET', path: '/healthz', admission: null })
const CONTRACT = contractAppWith([ME, EXPORT, DOWNLOAD, HEALTH], ['/api'])
const POLICY = headerPolicy(NO_CSP_ORIGINS, null)

const NAVIGATE = { 'Sec-Fetch-Mode': 'navigate' }
const verify = createVerifyService({ manifest: { apps: [CONTRACT] }, iam: new FakeIam(), issuer: ISSUER })

describe('a navigation the proxy refuses reads a page', () => {
	const cases: { name: string; status: ErrorPageStatus; request: Request; title: string }[] = [
		{
			name: 'a path no endpoint serves',
			status: 403,
			request: verifyRequest({ path: '/api/unknown', headers: NAVIGATE }),
			title: 'You cannot open this page',
		},
		{
			name: 'a host no application owns',
			status: 403,
			request: verifyRequest({ host: 'other.example.com', app: null, headers: NAVIGATE }),
			title: 'You cannot open this page',
		},
		{
			name: 'an endpoint that needs a key',
			status: 401,
			request: verifyRequest({ path: '/api/export', headers: NAVIGATE }),
			title: 'This page needs an access key',
		},
		{
			name: 'a non-canonical path',
			status: 400,
			request: verifyRequest({ path: '/api/../api/me', headers: NAVIGATE }),
			title: 'This request could not be read',
		},
	]
	for (const { name, status, request, title } of cases) {
		test(`${name}: ${status}`, async () => {
			const response = await verify(request)
			expect(response.status).toBe(status)
			expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
			expect(response.headers.get('Cache-Control')).toBe('no-store')
			expect(response.headers.get('Content-Security-Policy')).toBe(POLICY.find(([header]) => header === 'Content-Security-Policy')?.[1] ?? null)
			const body = await response.text()
			expect(body).toBe(errorPage(status))
			expect(body).toContain(`<title>${title}</title>`)
			expect(body).toContain(`Status ${status}`)
			// The reason stays in the log.
			for (const reason of ['no_endpoint', 'no_app', 'no_credential', 'non_canonical_path', 'caller']) expect(body).not.toContain(reason)
		})
	}
})

describe('every other caller reads the text', () => {
	const others: Record<string, string>[] = [{}, { 'Sec-Fetch-Mode': 'cors' }, { 'Sec-Fetch-Mode': 'no-cors' }, { 'Sec-Fetch-Mode': 'same-origin' }]
	for (const headers of others) {
		test(`Sec-Fetch-Mode ${JSON.stringify(headers)}`, async () => {
			const response = await verify(verifyRequest({ path: '/api/unknown', headers }))
			expect(response.status).toBe(403)
			expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
			expect(await response.text()).toBe('forbidden')
		})
	}

	test('Accept: text/html does not ask for the page: only the browser writes the navigation', async () => {
		const response = await verify(verifyRequest({ path: '/api/unknown', headers: { 'Sec-Fetch-Mode': 'cors', Accept: 'text/html' } }))
		expect(await response.text()).toBe('forbidden')
	})

	test("a download endpoint's refusal stays the text under the file treatment, which would save a page as a file", async () => {
		const response = await verify(verifyRequest({ path: '/api/files.avatar/f1', bearer: 'not-a-key', headers: NAVIGATE }))
		expect(response.status).toBe(401)
		expect(await response.text()).toBe('unauthorized')
		for (const [name, value] of appFileTreatment(CONTRACT)) expect(response.headers.get(name)).toBe(value)
		expect(response.headers.get('Content-Disposition')).toBe('attachment')
	})

	test('a human endpoint without a session still bounces a navigation to sign-in', async () => {
		const response = await verify(verifyRequest({ path: '/api/me', headers: NAVIGATE }))
		expect(response.status).toBe(302)
	})
})

describe('the page', () => {
	const statuses: ErrorPageStatus[] = [400, 401, 403, 404, 502, 503, 504]

	test('loads nothing: no script, no external reference, only same-origin links', () => {
		for (const status of statuses) {
			const page = errorPage(status)
			expect(page).not.toMatch(/<script|<link|<img|<iframe|src=|url\(/i)
			for (const [, href] of page.matchAll(/href="([^"]*)"/g)) expect(href === '' || href === '/').toBe(true)
		}
	})

	test('holds no `{name}` Caddy could expand as a placeholder, only the status it is given', () => {
		for (const status of statuses) {
			expect(errorPage(status)).not.toMatch(/\{\S/)
			expect(errorPage(status, { shownStatus: '{http.error.status_code}' }).match(/\{\S[^}]*\}/g)).toEqual(['{http.error.status_code}'])
		}
	})

	test('a navigation is exactly `Sec-Fetch-Mode: navigate`', () => {
		expect(isPageNavigation(new Headers(NAVIGATE))).toBe(true)
		expect(isPageNavigation(new Headers())).toBe(false)
		expect(isPageNavigation(new Headers({ 'Sec-Fetch-Mode': 'cors' }))).toBe(false)
	})
})
