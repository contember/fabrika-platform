// Public egress (ADR-0075) sends each hop to the address it checked, with the checked name as `Host` and TLS
// `serverName` and `keepalive: false`, so a name that rebinds between the check and the connection reaches nothing new.
// That holds only while Bun's `fetch` sends that `Host`, checks the certificate against the `serverName` (since Bun 1.4
// no longer against `Host`), and, under `keepalive: false`, takes no pooled connection, which Bun keys by address and
// port, not by name. These tests hold the pinned Bun release to that against a local server. The TLS half needs
// `openssl` on PATH for its throwaway certificate.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NAME = 'pinned.example.com'

describe('what a pinned hop relies on in Bun', () => {
	test('a request to an address carries the Host it was given', async () => {
		const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => new Response(request.headers.get('host')) })
		try {
			const response = await fetch(`http://127.0.0.1:${server.port}/`, { headers: new Headers({ host: NAME }) })
			expect(await response.text()).toBe(NAME)
		} finally {
			await server.stop(true)
		}
	})

	const openssl = Bun.which('openssl')
	describe.skipIf(openssl === null)('over TLS (needs openssl)', () => {
		let directory = ''
		let ca = ''
		let server: ReturnType<typeof Bun.serve> | undefined
		beforeAll(() => {
			directory = mkdtempSync(join(tmpdir(), 'fabrika-pinning-'))
			const made = Bun.spawnSync([
				openssl ?? 'openssl',
				'req',
				'-x509',
				'-newkey',
				'ec',
				'-pkeyopt',
				'ec_paramgen_curve:prime256v1',
				'-nodes',
				'-days',
				'1',
				'-subj',
				`/CN=${NAME}`,
				'-addext',
				`subjectAltName=DNS:${NAME}`,
				'-keyout',
				join(directory, 'key.pem'),
				'-out',
				join(directory, 'cert.pem'),
			])
			expect(made.exitCode).toBe(0)
			ca = readFileSync(join(directory, 'cert.pem'), 'utf8')
			server = Bun.serve({
				hostname: '127.0.0.1',
				port: 0,
				tls: { cert: ca, key: readFileSync(join(directory, 'key.pem'), 'utf8') },
				fetch: (request) => new Response(request.headers.get('host')),
			})
		})
		afterAll(async () => {
			await server?.stop(true)
			rmSync(directory, { recursive: true, force: true })
		})

		const failure = async (work: () => Promise<Response>): Promise<string> => await work().then(() => '', (error: unknown) => String(error))

		test('the certificate is checked against the serverName: the checked name passes', async () => {
			const response = await fetch(`https://127.0.0.1:${server?.port}/`, { headers: new Headers({ host: NAME }), tls: { ca, serverName: NAME } })
			expect(await response.text()).toBe(NAME)
		})

		test('another name, or none, fails the certificate check, though a connection to the address is pooled', async () => {
			const url = `https://127.0.0.1:${server?.port}/`
			await (await fetch(url, { headers: new Headers({ host: NAME }), tls: { ca, serverName: NAME } })).text()
			const other = 'other.example.com'
			expect(await failure(() => fetch(url, { headers: new Headers({ host: other }), keepalive: false, tls: { ca, serverName: other } })))
				.toContain('ERR_TLS_CERT_ALTNAME_INVALID')
			expect(await failure(() => fetch(url, { keepalive: false, tls: { ca } }))).not.toBe('')
		})
	})
})
