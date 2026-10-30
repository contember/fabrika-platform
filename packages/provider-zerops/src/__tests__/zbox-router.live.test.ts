// What the dev sandboxes rely on of the Box router and of a sandbox's TTLs, run against a REAL Zerops Box Workspace.
//
// The same opt-in as `zbox.live.test.ts`, whose configuration it reads:
//
//   FABRIKA_LIVE_ZBOX_API_ORIGIN=https://<zbox 8080 subdomain> FABRIKA_LIVE_ZBOX_API_KEY=<ZBOX_WORKSPACE_API_KEY> \
//     bun test packages/provider-zerops/src/__tests__/zbox-router.live.test.ts
//
// The router listens only on the project network, so the requests come from a probe sandbox in the `PROJECT_INTERNET`
// network mode, sent as raw HTTP so that nothing rewrites a header. The target is a workspace sandbox exactly as
// `ensure` creates it (a `PROJECT`-access port 3000), serving an echo of the headers it receives.
//
// WHAT IT DOES TO THE WORKSPACE. It builds this release's sandbox base when missing, creates the target and the probe
// sandbox, and removes both again, including when a test failed. With `FABRIKA_LIVE_ZBOX_ARCHIVE=1` it also creates a
// third throwaway sandbox, gives that one (and only that one) an absolute TTL of 60 s, waits until Box archives it, and
// removes what is left. It never touches a sandbox it did not create, the workspace's TTLs or its bases.

import type { ProviderDevSandbox, ProviderEnvironment } from '@fabrika/provider-contract'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defaultSleep } from '../collaborators'
import { zeropsStoredTargetCodec } from '../control'
import { ZEROPS_APPLICATION_PORT } from '../execution'
import { zeropsArtifactCodec } from '../manifest'
import { SANDBOX_HOST_HOSTNAME, SANDBOX_HOST_ROUTER_PORT, sandboxUpstreamHost } from '../sandbox-host'
import { ensureSandboxBase, readSandboxBaseContext } from '../sandbox/base-image'
import { SANDBOX_INIT_COMMAND } from '../sandbox/constants'
import { createZeropsDevSandboxes, sandboxName } from '../sandbox/lifecycle'
import { createZboxClient, type ZboxClient } from '../zbox'
import { readLiveBox } from './helpers/live-box'

const box = readLiveBox(process.env)
const archive = process.env['FABRIKA_LIVE_ZBOX_ARCHIVE'] === '1'

if (box === null) {
	console.warn('zbox-router.live.test.ts skipped: set FABRIKA_LIVE_ZBOX_API_ORIGIN and FABRIKA_LIVE_ZBOX_API_KEY (see zbox.live.test.ts)')
}

const BASE_TIMEOUT_MS = 20 * 60_000
const STEP_TIMEOUT_MS = 180_000
const ARCHIVE_TIMEOUT_MS = 300_000
const CLEANUP_TIMEOUT_MS = 120_000

/** The DOT domain releases before the Box 2026-10 one added to the host; a host keyed by them still routes it. */
const LEGACY_DOMAIN = 'sandbox.fabrika.internal'

/** Where the scripts are uploaded; Bun runs a file, so its arguments are `process.argv.slice(2)`. */
const ECHO_PATH = '/tmp/fabrika-echo.ts'
const PROBE_PATH = '/tmp/fabrika-probe.ts'

const ECHO_SERVER = `Bun.serve({ port: ${ZEROPS_APPLICATION_PORT}, fetch: (request) => Response.json(Object.fromEntries(request.headers)) })`

/** One raw HTTP/1.1 request from inside the probe; prints the status line and the body as one JSON line. */
const RAW_REQUEST = `
const [address, host, extra] = process.argv.slice(2)
const [hostname, port] = address.split(':')
const lines = ['GET /probe HTTP/1.1', 'Host: ' + host, 'Connection: close', ...JSON.parse(extra), '', '']
let text = ''
await new Promise((resolve, reject) => {
	Bun.connect({ hostname, port: Number(port), socket: {
		open: (socket) => socket.write(lines.join('\\r\\n')),
		data: (_socket, chunk) => { text += new TextDecoder().decode(chunk) },
		close: resolve,
		error: (_socket, error) => reject(error),
		connectError: (_socket, error) => reject(error),
	} }).catch(reject)
})
const [head, ...rest] = text.split('\\r\\n\\r\\n')
let body = rest.join('\\r\\n\\r\\n')
if (/^transfer-encoding:\\s*chunked/im.test(head)) {
	let decoded = ''
	while (body.length > 0) {
		const end = body.indexOf('\\r\\n')
		const size = Number.parseInt(body.slice(0, end), 16)
		if (!(size > 0)) break
		decoded += body.slice(end + 2, end + 2 + size)
		body = body.slice(end + 4 + size)
	}
	body = decoded
}
console.log(JSON.stringify({ status: Number(head.split(' ')[1]), body }))
`

const answerSchema = z.object({ status: z.number(), body: z.string() })
const echoSchema = z.record(z.string())
const ttlSchema = z.object({ idleTtlSeconds: z.number().nullish(), absoluteTtlSeconds: z.number().nullish() })

const environment: ProviderEnvironment = {
	appId: 'notes',
	env: 'dev',
	kind: 'dev',
	target: { provider: 'zerops', version: zeropsStoredTargetCodec.version, payload: zeropsStoredTargetCodec.encode({ kind: 'devSandboxes' }) },
	artifact: { provider: 'zerops', version: zeropsArtifactCodec.version, payload: {} },
}

describe.skipIf(box === null)('the Box router and sandbox TTLs, against a real Zerops Box workspace', () => {
	const live = box ?? { origin: '', apiKey: '' }
	const client: ZboxClient = createZboxClient({ baseUrl: live.origin, apiKey: live.apiKey })
	const logged: string[] = []
	const sandboxes = createZeropsDevSandboxes({ client: () => client, admit: () => {}, sleep: defaultSleep, log: (line) => logged.push(line) })
	const workspaceId = Bun.randomUUIDv7()
	const archivedWorkspaceId = Bun.randomUUIDv7()
	let target: ProviderDevSandbox | null = null
	let probeId: string | null = null
	let router: string | null = null

	/** Box API calls the client does not offer. The key goes in one header; the body is parsed, never printed. */
	const raw = async (method: string, path: string, json?: unknown): Promise<unknown> => {
		const response = await fetch(`${live.origin}/api/rest${path}`, {
			method,
			headers: {
				authorization: `Bearer ${live.apiKey}`,
				accept: 'application/json',
				...(json === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }),
			},
			...(json === undefined ? {} : { body: JSON.stringify(json) }),
			signal: AbortSignal.timeout(55_000),
		})
		if (!response.ok) throw new Error(`zbox: ${method} ${path} answered ${response.status}`)
		return response.json()
	}

	const required = <T>(value: T | null, what: string): T => {
		if (value === null) throw new Error(`${what} was not set up by an earlier test`)
		return value
	}

	/** One request from the probe to the router; `null` when the probe could not connect at all. */
	const request = async (address: string, host: string, headers: readonly string[]) => {
		const result = await client.exec(
			required(probeId, 'the probe'),
			{ command: ['bun', PROBE_PATH, address, host, JSON.stringify(headers)], timeoutSeconds: 30 },
			AbortSignal.timeout(STEP_TIMEOUT_MS),
		)
		if (result.exitCode !== 0) return null
		return answerSchema.parse(JSON.parse(result.stdout.trim().split('\n').at(-1) ?? ''))
	}

	const echoed = (answer: { status: number; body: string } | null) => {
		if (answer === null || answer.status !== 200) return null
		return echoSchema.parse(JSON.parse(answer.body))
	}

	beforeAll(async () => {
		const signal = AbortSignal.timeout(BASE_TIMEOUT_MS)
		const baseDigest = await ensureSandboxBase(client, await readSandboxBaseContext(), { signal, sleep: defaultSleep })
		target = await sandboxes.ensure({ environment, workspaceId, sandboxKey: live.apiKey, signal })
		await client.putFile(target.sandboxId, ECHO_PATH, new TextEncoder().encode(`${ECHO_SERVER}\n`), { signal })
		await client.startProcess(target.sandboxId, { command: ['bun', ECHO_PATH] }, signal)
		for (let attempt = 0;; attempt += 1) {
			const ready = await client.exec(
				target.sandboxId,
				{ command: ['wget', '-q', '-O', '/dev/null', `http://127.0.0.1:${ZEROPS_APPLICATION_PORT}/`] },
				signal,
			)
			if (ready.exitCode === 0) break
			if (attempt >= 30) throw new Error('the echo server did not start in the target sandbox')
			await defaultSleep(1_000, signal)
		}
		const { sandbox } = await client.createSandbox({
			name: `fabrika-probe-${workspaceId}`,
			baseDigest,
			cpus: 1,
			memoryBytes: 512 * 1024 * 1024,
			networkMode: 'PROJECT_INTERNET',
			launch: { entrypoint: SANDBOX_INIT_COMMAND.slice(0, 1), cmd: SANDBOX_INIT_COMMAND.slice(1) },
			ports: [],
			idempotencyKey: crypto.randomUUID(),
		}, signal)
		probeId = sandbox.id
		await client.putFile(sandbox.id, PROBE_PATH, new TextEncoder().encode(RAW_REQUEST), { signal })
	}, BASE_TIMEOUT_MS)

	afterAll(async () => {
		const signal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS)
		for (const id of [workspaceId, archivedWorkspaceId]) {
			const found = await client.findSandboxByName(sandboxName(id), signal)
			const recorded = id === workspaceId ? target?.sandboxId : undefined
			for (const sandboxId of new Set([recorded, found?.id])) {
				if (sandboxId !== undefined) await sandboxes.remove({ environment, workspaceId: id, sandbox: { sandboxId }, sandboxKey: live.apiKey, signal })
			}
		}
		if (probeId !== null) await client.deleteSandbox(probeId, crypto.randomUUID(), signal)
	}, CLEANUP_TIMEOUT_MS)

	test('a sandbox created without TTLs gets none', async () => {
		const ttls = ttlSchema.parse(await raw('GET', `/sandbox/${required(target, 'the target').sandboxId}`))
		console.info(`zbox live: a new sandbox reads idleTtlSeconds=${ttls.idleTtlSeconds} absoluteTtlSeconds=${ttls.absoluteTtlSeconds}`)
		expect(ttls.idleTtlSeconds ?? 0).toBe(0)
		expect(ttls.absoluteTtlSeconds ?? 0).toBe(0)
	}, STEP_TIMEOUT_MS)

	test('the probe reaches the router, and the router routes the bare Host the proxy sends', async () => {
		const host = sandboxUpstreamHost(required(target, 'the target').sandboxId)
		for (const address of [`${SANDBOX_HOST_HOSTNAME}.zerops:${SANDBOX_HOST_ROUTER_PORT}`, `${SANDBOX_HOST_HOSTNAME}:${SANDBOX_HOST_ROUTER_PORT}`]) {
			const answer = await request(address, host, [])
			console.info(`zbox live: ${address} with Host ${host} answered ${answer === null ? 'no connection' : answer.status}`)
			if (answer !== null) {
				router = address
				expect(answer.status).toBe(200)
				break
			}
		}
		expect(router).not.toBeNull()
	}, STEP_TIMEOUT_MS)

	test('the legacy dotted Host still routes on a host that has the domain (informational)', async () => {
		const sandboxId = required(target, 'the target').sandboxId
		const answer = await request(required(router, 'the router'), `${ZEROPS_APPLICATION_PORT}-${sandboxId}.${LEGACY_DOMAIN}`, [])
		console.info(`zbox live: the dotted Host answered ${answer?.status ?? 'no connection'}`)
	}, STEP_TIMEOUT_MS)

	test('Authorization reaches the sandbox; X-Forwarded-For is refused on a PROJECT port', async () => {
		const address = required(router, 'the router')
		const host = sandboxUpstreamHost(required(target, 'the target').sandboxId)

		const authorized = echoed(await request(address, host, ['Authorization: Bearer live-probe']))
		expect(authorized?.['authorization']).toBe('Bearer live-probe')

		const forwarded = await request(address, host, ['X-Forwarded-For: 10.0.0.1'])
		console.info(`zbox live: a request carrying X-Forwarded-For answered ${forwarded?.status ?? 'no connection'}`)
		expect(forwarded?.status).not.toBe(200)
	}, STEP_TIMEOUT_MS)

	test.skipIf(!archive)('an ARCHIVED sandbox is replaced by the next ensure, and the one after finds the live one', async () => {
		const signal = AbortSignal.timeout(ARCHIVE_TIMEOUT_MS)
		const first = await sandboxes.ensure({ environment, workspaceId: archivedWorkspaceId, sandboxKey: live.apiKey, signal })
		// `PUT /sandbox/{id}` replaces the name and both TTLs together (Box's release notes).
		await raw('PUT', `/sandbox/${first.sandboxId}`, { name: sandboxName(archivedWorkspaceId), idleTtlSeconds: 0, absoluteTtlSeconds: 60 })
		let status = (await client.getSandbox(first.sandboxId, signal)).status
		while (status !== 'ARCHIVED') {
			await defaultSleep(5_000, signal)
			status = (await client.getSandbox(first.sandboxId, signal)).status
		}

		const replaced = await sandboxes.ensure({ environment, workspaceId: archivedWorkspaceId, sandboxKey: live.apiKey, signal })
		expect(replaced.sandboxId).not.toBe(first.sandboxId)
		expect(logged.some((line) => line.includes(`sandbox ${first.sandboxId} had ended`))).toBe(true)

		const again = await sandboxes.ensure({ environment, workspaceId: archivedWorkspaceId, sandboxKey: live.apiKey, signal })
		expect(again.sandboxId).toBe(replaced.sandboxId)
	}, ARCHIVE_TIMEOUT_MS)
})
