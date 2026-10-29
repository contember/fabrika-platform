// The deploy of a `dev` environment into one workspace's sandbox (ADR-0049): a plan of its own, separate from the Zerops
// build. The sandbox keeps its id for the workspace's life, so a re-bootstrap rebuilds inside it. Recovery never resumes
// (ADR-0044): a run whose invocation is lost settles failed, and the workspace binds again.

import { DEV_LAUNCHER_BOOTED_FILE } from '@fabrika/auth-core'
import {
	type DeployStepResult,
	isLeaseLoss,
	type JsonValue,
	type ProviderApprovedAccess,
	ProviderInvocationAbort,
	type ProviderManagedEnvironment,
	type ProviderRunEvents,
	runSteps,
} from '@fabrika/provider-contract'
import { z } from 'zod'
import type { Sleeper } from '../collaborators'
import { zeropsContractRun } from '../execution'
import type { FabrikaManifest } from '../manifest'
import type { ZeropsSourcePort, ZeropsSourcePrivateBinding } from '../source/port'
import type { ZeropsSourceRepository } from '../source/types'
import type { ZboxClient, ZboxExecResult } from '../zbox'
import {
	SANDBOX_APP_ROOT,
	SANDBOX_BIN_DIR,
	SANDBOX_BIN_POINTER,
	SANDBOX_BUILD_SCRIPT,
	SANDBOX_DATABASE_PASSWORD_FILE,
	SANDBOX_ENV_FILE,
	SANDBOX_LAUNCHER_LOG,
	SANDBOX_SOURCE_ARCHIVE,
} from './constants'
import {
	assertNoSandboxReferences,
	assertSandboxArtifact,
	authoredSpaCommands,
	maskValues,
	renderSandboxBuildScript,
	renderSandboxEnvFile,
	SANDBOX_LAUNCHER_CONFIG_PATH,
	sandboxBuildStepLabels,
	sandboxEnvironment,
	sandboxLauncherConfig,
	sandboxRecipe,
} from './dev-artifact'
import { runningSandbox } from './lifecycle'
import { readSandboxScripts, SANDBOX_SCRIPT_FILES, type SandboxScripts } from './scripts'

/** How long the build may run: the recipe's install, tests, `tsc` and checker; measured ≈8 s warm. */
const BUILD_DEADLINE_MS = 30 * 60_000
const BUILD_POLL_MS = 1_000

/** How long the launcher has to report its boot: the readiness window of a Zerops dev container. */
export const SANDBOX_BOOT_DEADLINE_MS = 180_000
const BOOT_POLL_MS = 2_000

/** Box cuts an exec off at 60 s. */
const EXEC_TIMEOUT_SECONDS = 55

const BOOTED_PATH = `${SANDBOX_APP_ROOT}/${DEV_LAUNCHER_BOOTED_FILE}`

/** The run checkpoint of a sandbox deploy: credential-free coordinates, read back only to settle the run failed. */
export interface ZeropsSandboxRunState {
	readonly sandboxId: string
	readonly runId: string
	readonly buildSessionId?: string
}

const sandboxCheckpointSchema = z.object({
	sandboxId: z.string().min(1),
	runId: z.string().min(1),
	buildSessionId: z.string().min(1).optional(),
}).strict()

export const sandboxExternalId = (state: Pick<ZeropsSandboxRunState, 'sandboxId' | 'runId'>): string => `sandbox:${state.sandboxId}:${state.runId}`

/** The sandbox checkpoint recorded for exactly this external id, or null. */
export function parseSandboxCheckpoint(input: { readonly providerState?: JsonValue; readonly externalId: string }): ZeropsSandboxRunState | null {
	const parsed = sandboxCheckpointSchema.safeParse(input.providerState)
	return parsed.success && sandboxExternalId(parsed.data) === input.externalId ? parsed.data : null
}

const encodeCheckpoint = (state: ZeropsSandboxRunState): JsonValue => ({
	sandboxId: state.sandboxId,
	runId: state.runId,
	...(state.buildSessionId === undefined ? {} : { buildSessionId: state.buildSessionId }),
})

export interface ZeropsSandboxDeployRun {
	readonly appId: string
	readonly env: string
	readonly runId: string
	readonly artifact: FabrikaManifest
	readonly access: ProviderApprovedAccess | undefined
	readonly vars: Readonly<Record<string, string>>
	readonly secrets: Readonly<Record<string, string>>
	readonly managedEnvironment: ProviderManagedEnvironment
	/** Absent on a dry run, which resolves no source. */
	readonly source?: {
		readonly repository: ZeropsSourceRepository
		readonly commitSha: string
		readonly privateBinding?: ZeropsSourcePrivateBinding
	}
	readonly sandbox: {
		readonly sandboxId: string
		/** The sandbox host's API origin; the source upload goes to its file endpoint. */
		readonly apiOrigin: string
		/** A credential in transit: the bearer of the source upload. Never logged, persisted or put in an argument. */
		readonly sandboxKey: string
	}
	readonly client: ZboxClient
	readonly sourcePort: ZeropsSourcePort
	readonly sleep: Sleeper
	readonly dryRun: boolean
	readonly signal: AbortSignal
	readonly events: ProviderRunEvents
	/** The helper scripts to upload; the ones this package ships unless a test passes others. */
	readonly scripts?: SandboxScripts
}

export interface ZeropsSandboxDeployResult {
	readonly status: 'succeeded' | 'failed'
	readonly steps: readonly DeployStepResult[]
}

type SandboxStepId =
	| 'wake-sandbox'
	| 'install-scripts'
	| 'stop-previous'
	| 'upload-source'
	| 'build'
	| 'write-env'
	| 'write-launcher-config'
	| 'start-launcher'
	| 'await-boot'

// The environment is written only after the build: the build runs the application's own code, which never sees it.
const SANDBOX_STEPS: readonly { readonly id: SandboxStepId; readonly description: string }[] = [
	{ id: 'wake-sandbox', description: "wake the workspace's sandbox" },
	{ id: 'install-scripts', description: 'upload the helper scripts of this release' },
	{ id: 'stop-previous', description: 'stop the previous launcher and build, delete the launcher environment, secure the database' },
	{ id: 'upload-source', description: 'upload the commit and swap it into the application root' },
	{ id: 'build', description: 'run the build and its checks as the unprivileged build user' },
	{ id: 'write-env', description: 'write the launcher environment (0600)' },
	{ id: 'write-launcher-config', description: 'write the dev launcher configuration' },
	{ id: 'start-launcher', description: 'start the dev launcher' },
	{ id: 'await-boot', description: 'wait for the launcher to report its boot' },
]

/** A cancel stops the step; a lost lease stops it too, and leaves the sandbox to the next owner untouched. */
const assertRunning = (signal: AbortSignal): void => {
	if (!signal.aborted) return
	if (signal.reason instanceof ProviderInvocationAbort) throw signal.reason
	throw new ProviderInvocationAbort('cancel_requested')
}

/** The source's file endpoint for one sandbox, written exactly as a URL parser writes it (Control compares). */
export const sandboxSourceUploadUrl = (apiOrigin: string, sandboxId: string): string =>
	`${apiOrigin.replace(/\/+$/, '')}/api/rest/sandbox/${sandboxId}/file?path=${SANDBOX_SOURCE_ARCHIVE}`

/** Replaces the application root with the archive's tree; state outside it (PGDATA, the env file) is kept. */
const EXTRACT_SOURCE = [
	'/bin/sh',
	'-c',
	`set -eu; rm -rf ${SANDBOX_APP_ROOT}.next ${SANDBOX_APP_ROOT}.prev; mkdir ${SANDBOX_APP_ROOT}.next; `
	+ `tar -xzf ${SANDBOX_SOURCE_ARCHIVE} -C ${SANDBOX_APP_ROOT}.next; rm -f ${SANDBOX_SOURCE_ARCHIVE}; `
	+ `if [ -e ${SANDBOX_APP_ROOT} ]; then mv ${SANDBOX_APP_ROOT} ${SANDBOX_APP_ROOT}.prev; fi; `
	+ `mv ${SANDBOX_APP_ROOT}.next ${SANDBOX_APP_ROOT}; rm -rf ${SANDBOX_APP_ROOT}.prev`,
]

const lastLines = (text: string, count: number): string[] => text.split('\n').map((line) => line.trim()).filter((line) => line !== '').slice(-count)

/** One bounded command in the sandbox; a non-zero exit fails the step with the command's last lines. */
const execOrThrow = async (run: ZeropsSandboxDeployRun, what: string, command: readonly string[]): Promise<ZboxExecResult> => {
	const result = await run.client.exec(run.sandbox.sandboxId, { command: [...command], timeoutSeconds: EXEC_TIMEOUT_SECONDS }, run.signal)
	if (result.timedOut) throw new Error(`zerops: ${what} did not finish within ${EXEC_TIMEOUT_SECONDS} s`)
	if (result.exitCode !== 0) {
		const output = lastLines(`${result.stdout}\n${result.stderr}`, 3).join(' / ')
		throw new Error(`zerops: ${what} failed with exit code ${result.exitCode ?? 'none'}${output === '' ? '' : `: ${output}`}`)
	}
	return result
}

/** Splits relayed bytes into whole lines, each masked; a trailing partial line waits for the next read. */
class LineRelay {
	private readonly decoder = new TextDecoder()
	private partial = ''
	constructor(private readonly log: (line: string) => void, private readonly secrets: readonly string[]) {}

	push(bytes: Uint8Array): void {
		const lines = (this.partial + this.decoder.decode(bytes, { stream: true })).split('\n')
		this.partial = lines.pop() ?? ''
		for (const line of lines) this.emit(line.replace(/\r$/, ''))
	}

	flush(): void {
		const rest = this.partial + this.decoder.decode()
		this.partial = ''
		if (rest !== '') this.emit(rest)
	}

	private emit(line: string): void {
		this.log(`  │ ${maskValues(line, this.secrets)}`)
	}
}

/** The bytes last relayed that a new read must still hold at the same offset; a bounded check of a cumulative buffer. */
const RELAY_WINDOW_BYTES = 4096

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
	left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])

/**
 * Relays a session's cumulative output: only the bytes past what it relayed. A read that no longer holds the relayed
 * bytes where they were (the host cut its buffer) is reported once per cut and relaying resumes at its end.
 */
export class SessionOutputRelay {
	private relayed = 0
	private window: Uint8Array = new Uint8Array()
	private readonly lines: LineRelay

	constructor(private readonly log: (line: string) => void, secrets: readonly string[]) {
		this.lines = new LineRelay(log, secrets)
	}

	/** How many bytes the session has produced, as far as this relay knows. */
	get size(): number {
		return this.relayed
	}

	accept(output: Uint8Array): void {
		const held = output.byteLength >= this.relayed && sameBytes(output.subarray(this.relayed - this.window.byteLength, this.relayed), this.window)
		if (held) {
			this.lines.push(output.subarray(this.relayed))
		} else {
			this.lines.flush()
			this.log('  [warn] build output was truncated by the sandbox host; relaying what follows')
		}
		this.relayed = output.byteLength
		this.window = output.slice(Math.max(0, output.byteLength - RELAY_WINDOW_BYTES))
	}

	flush(): void {
		this.lines.flush()
	}
}

/** The output endpoint answers the whole buffer, so a large one is read less often. */
const buildPollMs = (outputBytes: number): number =>
	outputBytes < 256 * 1024 ? BUILD_POLL_MS : outputBytes < 4 * 1024 * 1024 ? 3 * BUILD_POLL_MS : 10 * BUILD_POLL_MS

interface DeployContext {
	readonly run: ZeropsSandboxDeployRun
	readonly scripts: SandboxScripts
	/** Every value a log line must not show: the environment's and the sandbox key. */
	readonly secrets: readonly string[]
}

/** Best-effort: the run is already giving up, and a refused or slow stop must not replace the reason. */
const stopBuildQuietly = async ({ run, scripts }: DeployContext): Promise<void> => {
	await run.client.exec(
		run.sandbox.sandboxId,
		{ command: ['/bin/sh', scripts.path('stop.sh'), 'build'], timeoutSeconds: EXEC_TIMEOUT_SECONDS },
		AbortSignal.timeout(30_000),
	).catch(() => undefined)
}

/**
 * Runs the build as one detached process (an exec is cut off at 60 s) and relays its output into the run log. A cancel
 * stops the build; a lost lease leaves it.
 */
const runBuild = async (context: DeployContext, script: string, checkpoint: ZeropsSandboxRunState): Promise<void> => {
	const { run, secrets } = context
	const { client, signal, events } = run
	const sandboxId = run.sandbox.sandboxId
	await client.putFile(sandboxId, SANDBOX_BUILD_SCRIPT, new TextEncoder().encode(script), { mode: '0700', signal })
	assertRunning(signal)
	const session = await client.startProcess(sandboxId, { command: ['/bin/sh', SANDBOX_BUILD_SCRIPT], workingDir: SANDBOX_APP_ROOT }, signal)
	await events.checkpoint(encodeCheckpoint({ ...checkpoint, buildSessionId: session.id }))
	const relay = new SessionOutputRelay(events.log, secrets)
	const deadline = Date.now() + BUILD_DEADLINE_MS
	let relayFailed = false
	const relayOutput = async (): Promise<void> => {
		try {
			relay.accept(await client.sessionOutput(session.id, signal))
		} catch {
			if (signal.aborted) return
			if (!relayFailed) events.log('  [warn] the build output could not be read; the build continues')
			relayFailed = true
		}
	}
	try {
		for (;;) {
			const crossed: unknown = await events.boundary().then(() => null, (error: unknown) => error)
			if (isLeaseLoss(crossed)) throw crossed
			assertRunning(signal)
			await relayOutput()
			let state: Awaited<ReturnType<ZboxClient['getSession']>> | null = null
			try {
				state = await client.getSession(session.id, signal)
			} catch {
				assertRunning(signal)
				events.log('  build status unavailable; retrying')
			}
			if (state !== null && state.status !== 'OPEN') {
				await relayOutput()
				relay.flush()
				if (state.exitCode === 0) return
				throw new Error(`zerops: the build failed with exit code ${state.exitCode ?? 'none'}`)
			}
			if (Date.now() > deadline) {
				await stopBuildQuietly(context)
				throw new Error(`zerops: the build did not finish within ${BUILD_DEADLINE_MS / 60_000} minutes; it was stopped`)
			}
			await run.sleep(buildPollMs(relay.size), signal)
		}
	} catch (error) {
		if (signal.aborted && !isLeaseLoss(signal.reason)) await stopBuildQuietly(context)
		throw error
	}
}

const LAUNCHER_LOG_LINES = 10

const awaitBoot = async ({ run, secrets }: DeployContext): Promise<void> => {
	const deadline = Date.now() + SANDBOX_BOOT_DEADLINE_MS
	for (;;) {
		assertRunning(run.signal)
		if ((await run.client.getFile(run.sandbox.sandboxId, BOOTED_PATH, run.signal)) !== null) return
		if (Date.now() > deadline) {
			const logged = await run.client.getFile(run.sandbox.sandboxId, SANDBOX_LAUNCHER_LOG, run.signal).catch(() => null)
			// The launcher's database URL carries a password Control never handed: masked too, or the tail is not shown.
			const password = await run.client.getFile(run.sandbox.sandboxId, SANDBOX_DATABASE_PASSWORD_FILE, run.signal).then(
				(bytes) => bytes === null ? '' : new TextDecoder().decode(bytes).trim(),
				() => null,
			)
			const tail = logged === null || password === null
				? []
				: lastLines(maskValues(new TextDecoder().decode(logged), [...secrets, password]), LAUNCHER_LOG_LINES)
			throw new Error(
				`zerops: the dev launcher did not report its boot within ${SANDBOX_BOOT_DEADLINE_MS / 1000} s${
					tail.length === 0 ? '' : `; its log ends: ${tail.join(' | ')}`
				}`,
			)
		}
		await run.sleep(BOOT_POLL_MS, run.signal)
	}
}

/** Uploads this release's helper scripts under their version, then points `current` at them. */
const installScripts = async ({ run, scripts }: DeployContext): Promise<void> => {
	const sandboxId = run.sandbox.sandboxId
	const directory = `${SANDBOX_BIN_DIR}/${scripts.version}`
	await execOrThrow(run, 'creating the script directory', [
		'/bin/sh',
		'-c',
		`set -eu; mkdir -p ${directory}; chmod 700 ${SANDBOX_BIN_DIR} ${directory}`,
	])
	for (const name of SANDBOX_SCRIPT_FILES) {
		const content = scripts.files[name]
		if (content === undefined) throw new Error(`zerops: the sandbox script ${name} is missing from this package`)
		await run.client.putFile(sandboxId, scripts.path(name), new Uint8Array(content), { mode: '0700', signal: run.signal })
	}
	// Last, so a cold boot never starts a half-uploaded version.
	await run.client.putFile(sandboxId, SANDBOX_BIN_POINTER, new TextEncoder().encode(`${scripts.version}\n`), { mode: '0600', signal: run.signal })
}

/** Deploy one workspace's sandbox. Refusals throw before any step; a step failure fails the run. */
export async function deploySandbox(run: ZeropsSandboxDeployRun): Promise<ZeropsSandboxDeployResult> {
	const { artifact, access, events, signal, dryRun } = run
	if (artifact.app.id !== run.appId || artifact.app.env !== run.env) throw new Error('zerops: the artifact names another environment')
	if (access === undefined && !dryRun) throw new Error('zerops: Control approved no access for this environment')
	const contract = access === undefined ? artifact.target.contract : zeropsContractRun(access.contract, access.contractDigest)
	if (contract === undefined) throw new Error('zerops: a dev environment runs a contract application')
	assertSandboxArtifact(artifact, contract)
	assertNoSandboxReferences('variable', run.vars)
	const environment = sandboxEnvironment({
		artifact,
		secrets: run.secrets,
		managed: run.managedEnvironment,
		contractDigest: access?.contractDigest ?? contract.digest,
	})
	const spa = authoredSpaCommands(artifact)
	const recipeInput = access === undefined ? null : { appId: artifact.app.id, checkRelease: access.checker, contract }
	const recipe = recipeInput === null ? null : sandboxRecipe(recipeInput)
	const sandboxId = run.sandbox.sandboxId
	// It is written into the upload URL unescaped, as Control's destination check reads it.
	if (!/^[a-z0-9]{1,32}$/.test(sandboxId)) throw new Error('zerops: a sandbox id is lower-case letters and digits')
	const context: DeployContext = {
		run,
		scripts: run.scripts ?? await readSandboxScripts(),
		secrets: [...Object.values(environment), run.sandbox.sandboxKey],
	}
	const { scripts } = context
	const checkpoint: ZeropsSandboxRunState = { sandboxId, runId: run.runId }
	if (!dryRun) {
		if (run.source === undefined) throw new Error('zerops: a sandbox deploy needs the resolved source')
		await events.externalId(sandboxExternalId(checkpoint), encodeCheckpoint(checkpoint))
	}
	const log = events.log
	const step = async (id: SandboxStepId): Promise<void> => {
		await events.boundary()
		assertRunning(signal)
		if (dryRun) {
			log(`  [dry-run] would ${SANDBOX_STEPS.find((candidate) => candidate.id === id)?.description ?? id} in sandbox ${sandboxId}`)
			return
		}
		const source = run.source
		if (source === undefined || recipeInput === null || recipe === null) {
			throw new Error('zerops: a sandbox deploy needs the resolved source and approved access')
		}
		switch (id) {
			case 'wake-sandbox': {
				const sandbox = await runningSandbox(run.client, sandboxId, run.sleep, signal)
				log(`  sandbox ${sandbox.id} is running on base ${sandbox.baseDigest}`)
				return
			}
			case 'install-scripts': {
				await installScripts(context)
				log(`  scripts ${scripts.version}`)
				return
			}
			case 'stop-previous': {
				await execOrThrow(run, 'stopping the previous launcher and build', ['/bin/sh', scripts.path('reset.sh')])
				return
			}
			case 'upload-source': {
				const uploaded = await run.sourcePort.upload({
					repository: source.repository,
					commitSha: source.commitSha,
					descriptorSha256: artifact.target.sourceDescriptor.sha256,
					archive: { kind: 'application', ...(source.privateBinding === undefined ? {} : { privateBinding: source.privateBinding }) },
					uploadUrl: sandboxSourceUploadUrl(run.sandbox.apiOrigin, sandboxId),
					uploadBearer: run.sandbox.sandboxKey,
					signal,
				})
				if (uploaded.commitSha !== source.commitSha || uploaded.descriptorSha256 !== artifact.target.sourceDescriptor.sha256) {
					throw new Error('zerops: source upload returned different coordinates')
				}
				await execOrThrow(run, 'extracting the source', EXTRACT_SOURCE)
				log(`  ${source.commitSha} is the application root (${uploaded.entryCount} entries)`)
				return
			}
			case 'build': {
				for (const label of sandboxBuildStepLabels(spa, recipe)) log(`  ${label}`)
				await runBuild(context, renderSandboxBuildScript(spa, recipe, scripts.path('run-build.sh')), checkpoint)
				return
			}
			case 'write-env': {
				await run.client.putFile(sandboxId, SANDBOX_ENV_FILE, new TextEncoder().encode(renderSandboxEnvFile(environment)), { mode: '0600', signal })
				log(`  ${Object.keys(environment).length} variable(s): ${Object.keys(environment).join(', ')}`)
				return
			}
			case 'write-launcher-config': {
				const config = sandboxLauncherConfig({ ...recipeInput, head: source.commitSha, spaBuild: spa })
				await run.client.putFile(sandboxId, SANDBOX_LAUNCHER_CONFIG_PATH, new TextEncoder().encode(JSON.stringify(config)), { signal })
				return
			}
			case 'start-launcher': {
				await execOrThrow(run, 'starting the launcher', ['/bin/sh', scripts.path('start-launcher.sh')])
				return
			}
			case 'await-boot': {
				await awaitBoot(context)
				log('  the launcher reported its boot')
				return
			}
		}
	}
	return runSteps(SANDBOX_STEPS, { appId: run.appId, env: run.env, dryRun, signal, log }, (spec) => step(spec.id))
}
