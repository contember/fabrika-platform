// The dev sandbox lifecycle, run against a REAL Zerops Box Workspace (a `zbox@1` service).
//
// Opt-in, the same convention as the live platform-facts table: configure it and it runs, leave it unconfigured and it
// skips with a message saying what to set and what the run will do.
//
//   FABRIKA_LIVE_ZBOX_API_ORIGIN=https://<zbox 8080 subdomain> FABRIKA_LIVE_ZBOX_API_KEY=<ZBOX_WORKSPACE_API_KEY> \
//     bun test packages/provider-zerops/src/__tests__/zbox.live.test.ts
//
// WHAT IT DOES TO THE WORKSPACE. It builds this release's sandbox base when the workspace does not hold it yet (and
// leaves it there, as an installation would), creates one sandbox for a fresh throwaway workspace id, and removes that
// sandbox again — including when a test failed. It never touches a sandbox it did not create.
//
// The key is read here and put in one header. It is never logged, never asserted on, and never in a failure message.

import { type ProviderDevSandbox, type ProviderEnvironment } from '@fabrika/provider-contract'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { defaultSleep } from '../collaborators'
import { zeropsStoredTargetCodec } from '../control'
import { zeropsArtifactCodec } from '../manifest'
import { ensureSandboxBase, readSandboxBaseContext, type SandboxBaseContext } from '../sandbox/base-image'
import { SANDBOX_APP_ROOT, SANDBOX_BIN_DIR, SANDBOX_BIN_POINTER, SANDBOX_ENV_FILE, SANDBOX_STATE_DIR } from '../sandbox/constants'
import { createZeropsDevSandboxes, sandboxName } from '../sandbox/lifecycle'
import { readSandboxScripts, SANDBOX_SCRIPT_FILES } from '../sandbox/scripts'
import { createZboxClient, type ZboxClient } from '../zbox'

const PREFIX = 'FABRIKA_LIVE_ZBOX_'
const ORIGIN_VAR = `${PREFIX}API_ORIGIN`
const KEY_VAR = `${PREFIX}API_KEY`
const REQUIRED_NAMES = [ORIGIN_VAR, KEY_VAR]

interface LiveBox {
	origin: string
	apiKey: string
}

/** No configuration skips; a PARTIAL configuration throws rather than producing a false green. */
export function readLiveBox(environment: Record<string, string | undefined>): LiveBox | null {
	const configured = REQUIRED_NAMES.filter((name) => present(environment[name]))
	if (configured.length === 0) {
		return null
	}
	const missing = REQUIRED_NAMES.filter((name) => !present(environment[name]))
	if (missing.length > 0) {
		throw new Error(`Incomplete live Zerops Box test configuration; missing ${missing.join(', ')}`)
	}
	const raw = environment[ORIGIN_VAR] ?? ''
	const url = URL.parse(raw)
	// The key goes to whatever this names, so it must be a bare https origin and nothing that could redirect the path.
	if (url === null || url.protocol !== 'https:' || url.origin !== raw.replace(/\/$/, '')) {
		throw new Error(`${ORIGIN_VAR} must be a bare https origin, such as https://zbox-xxxx-8080.prg1.zerops.app`)
	}
	return { origin: url.origin, apiKey: environment[KEY_VAR] ?? '' }
}

function present(value: string | undefined): boolean {
	return value !== undefined && value !== ''
}

const box = readLiveBox(process.env)

export const skipReason = `skipped: set ${ORIGIN_VAR} (the Box workspace's public API origin, port 8080) and ${KEY_VAR} (its `
	+ 'ZBOX_WORKSPACE_API_KEY) to run the dev sandbox lifecycle against a real Zerops Box workspace — it builds the sandbox '
	+ 'base if missing, creates one throwaway sandbox, and removes it again'

if (box === null) {
	console.warn(`zbox.live.test.ts ${skipReason}`)
}

/** A first base build installs packages and flattens the image: minutes, not seconds. */
const BASE_TIMEOUT_MS = 20 * 60_000
const STEP_TIMEOUT_MS = 180_000
const CLEANUP_TIMEOUT_MS = 120_000
const POSTGRES_READY_DEADLINE_MS = 60_000
const BUILD_DEADLINE_MS = 120_000

/** The lifecycle reads only the kind; the envelopes are the ones a dev environment stores. */
const environment: ProviderEnvironment = {
	appId: 'notes',
	env: 'dev',
	kind: 'dev',
	target: { provider: 'zerops', version: zeropsStoredTargetCodec.version, payload: zeropsStoredTargetCodec.encode({ kind: 'devSandboxes' }) },
	artifact: { provider: 'zerops', version: zeropsArtifactCodec.version, payload: {} },
}

/** The build user of the base image (`sandbox/Dockerfile`). */
const BUILD_USER = 'fabrika-build'
const STEP_DIRECTORY = `${SANDBOX_STATE_DIR}/build`
const POSTGRES_PASSWORD_FILE = `${SANDBOX_STATE_DIR}/postgres-password`

const PSQL_AS_ROOT = 'su-exec postgres psql -X -q -t -A -v ON_ERROR_STOP=1 -h /run/postgresql -U postgres -d postgres'

describe.skipIf(box === null)('dev sandboxes, against a real Zerops Box workspace', () => {
	const live = box ?? { origin: '', apiKey: '' }
	const client: ZboxClient = createZboxClient({ baseUrl: live.origin, apiKey: live.apiKey })
	const logged: string[] = []
	const sandboxes = createZeropsDevSandboxes({ client: () => client, sleep: defaultSleep, log: (line) => logged.push(line) })
	// A fresh UUIDv7 per run: parallel runs never share a sandbox name.
	const workspaceId = Bun.randomUUIDv7()
	const marker = `m${workspaceId.replaceAll('-', '')}`
	let context: SandboxBaseContext
	let sandbox: ProviderDevSandbox | null = null

	const sandboxId = (): string => {
		if (sandbox === null) throw new Error('the sandbox was not created by an earlier test')
		return sandbox.sandboxId
	}

	const shell = async (script: string, signal: AbortSignal) => {
		const result = await client.exec(sandboxId(), { command: ['/bin/sh', '-c', script], timeoutSeconds: 55 }, signal)
		return { ...result, stdout: result.stdout.trim() }
	}

	const awaitPostgres = async (signal: AbortSignal): Promise<void> => {
		const deadline = Date.now() + POSTGRES_READY_DEADLINE_MS
		for (;;) {
			const ready = await shell('pg_isready -q -h 127.0.0.1 -p 5432', signal)
			if (ready.exitCode === 0) return
			if (Date.now() > deadline) throw new Error('PostgreSQL did not accept connections on 127.0.0.1:5432')
			await defaultSleep(1_000, signal)
		}
	}

	beforeAll(async () => {
		context = await readSandboxBaseContext()
	})

	afterAll(async () => {
		const signal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS)
		// By name too: an ensure that failed after its create returned no id.
		const found = await client.findSandboxByName(sandboxName(workspaceId), signal)
		for (const id of new Set([sandbox?.sandboxId, found?.id])) {
			if (id === undefined) continue
			await sandboxes.remove({ environment, sandbox: { sandboxId: id }, sandboxKey: live.apiKey, signal })
		}
	}, CLEANUP_TIMEOUT_MS)

	test('the base image builds, and a second ensure is a no-op with the same digest', async () => {
		const signal = AbortSignal.timeout(BASE_TIMEOUT_MS)
		const digest = await ensureSandboxBase(client, context, { signal, sleep: defaultSleep })
		expect(digest).not.toBe('')
		const bases = await client.listBases(signal)
		const named = bases.filter((base) => base.name === context.name && base.status !== 'DELETED')
		expect(named.map((base) => [base.status, base.digest])).toEqual([['READY', digest]])

		expect(await ensureSandboxBase(client, context, { signal, sleep: defaultSleep })).toBe(digest)
		expect((await client.listBases(signal)).filter((base) => base.name === context.name && base.status !== 'DELETED')).toHaveLength(1)
	}, BASE_TIMEOUT_MS)

	test('ensure is idempotent per workspace; the sandbox runs the pinned Bun and PostgreSQL on 127.0.0.1', async () => {
		const signal = AbortSignal.timeout(STEP_TIMEOUT_MS)
		sandbox = await sandboxes.ensure({ environment, workspaceId, sandboxKey: live.apiKey, signal })
		const again = await sandboxes.ensure({ environment, workspaceId, sandboxKey: live.apiKey, signal })
		expect(again.sandboxId).toBe(sandbox.sandboxId)
		expect(logged).toEqual([])
		expect((await client.getSandbox(sandbox.sandboxId, signal)).status).toBe('RUNNING')

		const pinned = (await Bun.file(new URL('../../../../.bun-version', import.meta.url)).text()).trim()
		const bun = await shell('bun --version', signal)
		expect([bun.exitCode, bun.stdout]).toEqual([0, pinned])

		await awaitPostgres(signal)
		const listening = await shell(`${PSQL_AS_ROOT} -c 'show listen_addresses'`, signal)
		expect([listening.exitCode, listening.stdout]).toEqual([0, '127.0.0.1'])
	}, STEP_TIMEOUT_MS)

	test('park then wake keeps the PostgreSQL data', async () => {
		const signal = AbortSignal.timeout(STEP_TIMEOUT_MS)
		const id = sandboxId()
		const created = await shell(`${PSQL_AS_ROOT} -c "create table ${marker} (value text); insert into ${marker} values ('kept')"`, signal)
		expect(created.exitCode).toBe(0)

		await sandboxes.park({ environment, sandbox: { sandboxId: id }, sandboxKey: live.apiKey, signal })
		let parked = await client.getSandbox(id, signal)
		while (parked.status === 'PARKING') {
			await defaultSleep(1_000, signal)
			parked = await client.getSandbox(id, signal)
		}
		expect(parked.status).toBe('PARKED')

		await sandboxes.wake({ environment, sandbox: { sandboxId: id }, sandboxKey: live.apiKey, signal })
		expect((await client.getSandbox(id, signal)).status).toBe('RUNNING')
		await awaitPostgres(signal)
		const read = await shell(`${PSQL_AS_ROOT} -c 'select value from ${marker}'`, signal)
		expect([read.exitCode, read.stdout]).toEqual([0, 'kept'])
	}, STEP_TIMEOUT_MS)

	test('the build runs isolated: no environment, no PostgreSQL credential, nothing left running, /app root-owned', async () => {
		const signal = AbortSignal.timeout(STEP_TIMEOUT_MS)
		const id = sandboxId()
		await awaitPostgres(signal)

		// Uploaded the way a deploy does: each script under its version, then the pointer.
		const scripts = await readSandboxScripts()
		const directory = `${SANDBOX_BIN_DIR}/${scripts.version}`
		expect((await shell(`set -eu; mkdir -p ${directory}; chmod 700 ${SANDBOX_BIN_DIR} ${directory}`, signal)).exitCode).toBe(0)
		for (const name of SANDBOX_SCRIPT_FILES) {
			const content = scripts.files[name]
			if (content === undefined) throw new Error(`the sandbox script ${name} is missing from this package`)
			await client.putFile(id, scripts.path(name), new Uint8Array(content), { mode: '0700', signal })
		}
		await client.putFile(id, SANDBOX_BIN_POINTER, new TextEncoder().encode(`${scripts.version}\n`), { mode: '0600', signal })

		await client.putFile(id, SANDBOX_ENV_FILE, new TextEncoder().encode('FABRIKA_LIVE_PROBE=1\n'), { mode: '0600', signal })
		expect(await client.getFile(id, SANDBOX_ENV_FILE, signal)).not.toBeNull()
		const reset = await shell(`/bin/sh ${scripts.path('reset.sh')}`, signal)
		expect(reset.exitCode).toBe(0)
		expect(await client.getFile(id, SANDBOX_ENV_FILE, signal)).toBeNull()
		// The control for the build's refusal below: with the password, TCP connects. It is read inside the sandbox only.
		const withPassword = await shell(
			`umask 077; printf '127.0.0.1:5432:*:postgres:%s\\n' "$(cat ${POSTGRES_PASSWORD_FILE})" >/root/.pgpass; `
				+ "PGCONNECT_TIMEOUT=5 psql -X -w -t -A -h 127.0.0.1 -U postgres -d postgres -c 'select 1' </dev/null; code=$?; rm -f /root/.pgpass; exit $code",
			signal,
		)
		expect([withPassword.exitCode, withPassword.stdout]).toEqual([0, '1'])

		const step = [
			'echo "user=$(id -un)"',
			`if cat ${POSTGRES_PASSWORD_FILE} >/dev/null 2>&1; then echo password=read; else echo password=denied; fi`,
			"if PGCONNECT_TIMEOUT=5 psql -X -w -h 127.0.0.1 -U postgres -d postgres -c 'select 1' </dev/null >/dev/null 2>&1; then echo tcp=connected; else echo tcp=refused; fi",
			'nohup sleep 600 >/dev/null 2>&1 &',
			'echo step=done',
		]
		expect((await shell(`set -eu; mkdir -p ${STEP_DIRECTORY} ${SANDBOX_APP_ROOT}; chmod 755 ${STEP_DIRECTORY}`, signal)).exitCode).toBe(0)
		await client.putFile(id, `${STEP_DIRECTORY}/1.sh`, new TextEncoder().encode(`${step.join('\n')}\n`), { mode: '0644', signal })

		const session = await client.startProcess(id, { command: ['/bin/sh', scripts.path('run-build.sh'), '1'], workingDir: SANDBOX_APP_ROOT }, signal)
		const deadline = Date.now() + BUILD_DEADLINE_MS
		let state = await client.getSession(session.id, signal)
		while (state.status === 'OPEN') {
			if (Date.now() > deadline) throw new Error('the build did not end')
			await defaultSleep(1_000, signal)
			state = await client.getSession(session.id, signal)
		}
		const output = new TextDecoder().decode(await client.sessionOutput(session.id, signal)).split('\n').map((line) => line.trim())
		expect(state.exitCode).toBe(0)
		expect(output).toContain(`user=${BUILD_USER}`)
		expect(output).toContain('password=denied')
		expect(output).toContain('tcp=refused')
		expect(output).toContain('step=done')
		expect(output).toContain('fabrika-build: done')

		const leftover = await shell(`uid=$(id -u ${BUILD_USER}); awk -v uid="$uid" '/^Uid:/ && $2 == uid' /proc/[0-9]*/status 2>/dev/null | wc -l`, signal)
		expect([leftover.exitCode, leftover.stdout]).toEqual([0, '0'])
		const owner = await shell(`stat -c %U:%G ${SANDBOX_APP_ROOT}`, signal)
		expect([owner.exitCode, owner.stdout]).toEqual([0, 'root:root'])
	}, STEP_TIMEOUT_MS)

	test('remove is idempotent', async () => {
		const signal = AbortSignal.timeout(STEP_TIMEOUT_MS)
		const id = sandboxId()
		await sandboxes.remove({ environment, sandbox: { sandboxId: id }, sandboxKey: live.apiKey, signal })
		await sandboxes.remove({ environment, sandbox: { sandboxId: id }, sandboxKey: live.apiKey, signal })
		const found = await client.findSandboxByName(sandboxName(workspaceId), signal)
		expect(found).toBeNull()
	}, STEP_TIMEOUT_MS)
})
