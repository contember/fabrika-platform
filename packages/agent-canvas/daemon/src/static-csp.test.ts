import { expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { sessionPageCsp } from './handlers/static'

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
