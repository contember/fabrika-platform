import { expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { INERT_DOCUMENT_CSP, sessionPageCsp, withDefaultCsp } from './handlers/static'

function directive(csp: string, name: string): string[] {
	const found = csp.split('; ').find((part) => part.startsWith(`${name} `))
	if (found === undefined) throw new Error(`No ${name} in ${csp}`)
	return found.split(' ').slice(1)
}

test('admits the page’s own inline scripts by hash and its external scripts by exact URL', () => {
	const inline = 'mermaid.initialize({ startOnLoad: false })'
	const html = `<head><script>${inline}</script><script src="https://cdn.example/lib@1.0.0/lib.min.js"></script></head>
<body><script type="importmap">{"imports":{}}</script><script type="module" src="/assets/client.js"></script></body>`
	const scripts = directive(sessionPageCsp(html), 'script-src')
	expect(scripts).toEqual([
		"'self'",
		`'sha256-${createHash('sha256').update(inline).digest('base64')}'`,
		'https://cdn.example/lib@1.0.0/lib.min.js',
		`'sha256-${createHash('sha256').update('{"imports":{}}').digest('base64')}'`,
	])
	expect(scripts).not.toContain("'unsafe-inline'")
	expect(scripts).not.toContain('https:')
})

test('keeps canvas JavaScript from connecting anywhere but the daemon', () => {
	const csp = sessionPageCsp('<body></body>')
	expect(directive(csp, 'connect-src')).toEqual(["'self'"])
	expect(directive(csp, 'default-src')).toEqual(["'self'"])
	expect(directive(csp, 'form-action')).toEqual(["'none'"])
	expect(directive(csp, 'img-src')).toContain('https:')
	expect(directive(csp, 'font-src')).toContain('https:')
})

test('gives every other response an inert policy, keeping one a route set', () => {
	expect(withDefaultCsp(Response.json({ ok: true })).headers.get('Content-Security-Policy')).toBe(INERT_DOCUMENT_CSP)
	const redirect = withDefaultCsp(Response.redirect('http://localhost:19400/s/demo', 302))
	expect(redirect.status).toBe(302)
	expect(redirect.headers.get('Location')).toBe('http://localhost:19400/s/demo')
	expect(redirect.headers.get('Content-Security-Policy')).toBe(INERT_DOCUMENT_CSP)
	const page = new Response('<html></html>', { headers: { 'Content-Security-Policy': "default-src 'self'" } })
	expect(withDefaultCsp(page).headers.get('Content-Security-Policy')).toBe("default-src 'self'")
})

test('allows no frames in the canvas page', () => {
	expect(directive(sessionPageCsp('<body></body>'), 'frame-src')).toEqual(["'none'"])
})

test('edits a file response in place, so Bun still serves its length and ranges', () => {
	const file = new Response(Bun.file(import.meta.path))
	expect(withDefaultCsp(file)).toBe(file)
	expect(file.headers.get('Content-Security-Policy')).toBe(INERT_DOCUMENT_CSP)
})
