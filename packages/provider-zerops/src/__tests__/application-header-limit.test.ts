// The hop from the proxy to an application on Zerops, over real HTTP: Bun started as the generated start script starts
// it takes the proxy's header set with an application token at its bound twice, beside a browser's own headers.

import {
	APPLICATION_SERVER_MAX_HEADER_BYTES,
	CLIENT_ADDRESS_HEADER,
	DELEGATION_HEADER,
	ENDPOINT_HEADER,
	MAX_APPLICATION_TOKEN_BYTES,
	PROXY_TOKEN_HEADER,
} from '@fabrika/auth-core'
import { REQUEST_ID_HEADER } from '@fabrika/proxy-core'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FABRIKA_CHECK_VERSION, generatedBuildCommands } from '../execution'

const SERVER = `const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') })
console.log(server.port)
`

const roots: string[] = []
const servers: Bun.Subprocess[] = []

afterEach(() => {
	for (const server of servers.splice(0)) server.kill()
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function serve(flags: readonly string[]): Promise<number> {
	const root = mkdtempSync(join(tmpdir(), 'fabrika-header-limit-'))
	roots.push(root)
	writeFileSync(join(root, 'server.ts'), SERVER)
	const server = Bun.spawn(['bun', ...flags, join(root, 'server.ts')], { stdout: 'pipe', stderr: 'inherit' })
	servers.push(server)
	const reader = server.stdout.getReader()
	const { value } = await reader.read()
	reader.releaseLock()
	return Number(new TextDecoder().decode(value).trim())
}

/** What the proxy forwards on a bearer request at the bound, beside 12 KiB of the browser's own headers and cookies. */
function proxiedHeaders(): Headers {
	const token = 'a'.repeat(MAX_APPLICATION_TOKEN_BYTES)
	return new Headers({
		Authorization: `Bearer ${token}`,
		[PROXY_TOKEN_HEADER]: token,
		[REQUEST_ID_HEADER]: crypto.randomUUID(),
		[ENDPOINT_HEADER]: 'notes.list',
		[DELEGATION_HEADER]: 'b'.repeat(256),
		[CLIENT_ADDRESS_HEADER]: '203.0.113.7',
		'X-Forwarded-For': '203.0.113.7',
		'X-Forwarded-Proto': 'https',
		'X-Forwarded-Host': 'notes.example.test',
		'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
		Accept: 'application/json',
		'Accept-Language': 'en-US,en;q=0.9',
		Cookie: `app_state=${'c'.repeat(12 * 1024)}`,
	})
}

describe('the header limit of an application server on Zerops', () => {
	test('the generated start script passes the limit to Bun', () => {
		const commands = generatedBuildCommands({
			appId: 'notes',
			contract: { digest: `sha256:${'0'.repeat(64)}`, readinessPath: '/healthz', jobs: [] },
			databaseUrl: 'postgres://db/notes',
			databaseConnections: 2,
			checkRelease: FABRIKA_CHECK_VERSION,
			storageHostname: null,
			runtimePackages: [],
			sourceMaps: null,
		}).join('\n')
		expect(commands).toContain(`exec bun --max-http-header-size=${APPLICATION_SERVER_MAX_HEADER_BYTES} fabrika/entry.generated.ts`)
	})

	test('a bearer request at the token bound reaches the application', async () => {
		const port = await serve([`--max-http-header-size=${APPLICATION_SERVER_MAX_HEADER_BYTES}`])
		const response = await fetch(`http://127.0.0.1:${port}/`, { headers: proxiedHeaders() })
		expect(response.status).toBe(200)
	})

	test("without the flag Bun's default refuses the same request", async () => {
		const port = await serve([])
		const response = await fetch(`http://127.0.0.1:${port}/`, { headers: proxiedHeaders() })
		expect(response.status).toBe(431)
	})
})
