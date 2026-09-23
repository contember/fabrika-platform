import type { RpcFetch } from '@fabrika/app'
import {
	type DeviceAuthorizationConsent,
	parseExchangeDeviceAuthorizationResult,
	parsePollDeviceAuthorizationResult,
	parseStartDeviceAuthorizationResult,
	type StartDeviceAuthorizationInput,
} from '@fabrika/auth-core'
import { parseBuilderConnectionReceipt } from '@fabrika/control-contract'
import { zeropsArtifactCodec, zeropsStoredTargetCodec } from '@fabrika/provider-zerops'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { type BuilderPairingState, type BuilderPlatformStatus, parseBuilderOrigin, parseBuilderPreviewUrl } from '../../shared'
import { DATA_DIR } from './paths'
import { parseEnvironments, parseRun, PlatformRemote } from './platform-remote'
import { compileProject, repositoryIdentity, verifySource } from './platform-source'
import { PlatformError, PlatformStorage, type ProjectRecord, type StoredCredential } from './platform-storage'

const PERMISSIONS = ['app.manage', 'deploy.trigger', 'deploy.read']
const KEY_LIFETIME = 30 * 24 * 60 * 60
const RECOVERY = 'The credential may already exist. Revoke this connection in the platform console, disconnect locally, then pair again.'

class ObservationError extends PlatformError {}

function activeDeployment(project: ProjectRecord): boolean {
	return project.deployment !== null && ['preparing', 'pending', 'running'].includes(project.deployment.status)
}

export interface BuilderPlatformOptions {
	stateDir?: string
	credentialDir?: string
	dataDir?: string
	fetch?: RpcFetch
	now?: () => number
	sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

export class BuilderPlatform {
	readonly storage: PlatformStorage
	private readonly stopped = new AbortController()
	private readonly operations = new Map<string, AbortController>()
	private readonly pairings = new Map<string, BuilderPairingState>()
	private readonly targets = new Map<string, string>()
	private readonly now: () => number
	private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
	private readonly fetcher: RpcFetch | undefined

	constructor(private readonly sessionRoot: (id: string) => string | undefined, options: BuilderPlatformOptions = {}) {
		const dataDir = resolve(options.dataDir ?? DATA_DIR)
		this.storage = new PlatformStorage(
			resolve(options.stateDir ?? join(dataDir, 'builder-projects')),
			resolve(options.credentialDir ?? join(homedir(), '.fabrika-builder', 'credentials')),
			dataDir,
		)
		this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
		this.sleep = options.sleep ?? (async (ms, signal) => {
			await setTimeout(ms, undefined, { signal })
		})
		this.fetcher = options.fetch
	}

	stop(): void {
		this.stopped.abort()
	}

	projectRoot(id: string): string | undefined {
		return this.storage.project(id)?.projectRoot ?? this.sessionRoot(id)
	}

	register(id: string, root: string): BuilderPlatformStatus {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new PlatformError('Invalid project session ID')
		const projectRoot = this.storage.assertProjectRoot(root)
		const existing = this.storage.project(id)
		const session = this.sessionRoot(id)
		if ((existing && existing.projectRoot !== projectRoot) || (session && this.storage.assertProjectRoot(session) !== projectRoot)) {
			throw new PlatformError('Session is already bound to another project root')
		}
		const project = existing ?? { sessionId: id, projectRoot, deployment: null, recoveryRequired: false }
		this.storage.config(project)
		this.storage.saveProject(project)
		return this.status(id)
	}

	private project(id: string): ProjectRecord {
		const project = this.storage.project(id)
		if (!project) throw new PlatformError('Register the project before using platform actions')
		this.storage.config(project)
		return project
	}

	status(id: string): BuilderPlatformStatus {
		const project = this.project(id)
		const config = this.storage.config(project)
		let credential: StoredCredential | null = null
		try {
			credential = this.storage.credential(id)
		} catch (error) {
			if (!project.recoveryRequired) throw error
		}
		if (
			project.deployment?.runId && (project.deployment.status === 'pending' || project.deployment.status === 'running') && !this.operations.has(id)
			&& credential
		) {
			this.resume(project, credential)
		} else if (project.deployment?.status === 'preparing' && !project.deployment.commitSha && !this.operations.has(id)) {
			project.deployment = {
				...project.deployment,
				status: 'failed',
				message: project.deployment.commitSha
					? 'Deployment submission was interrupted. Inspect Control for a run before retrying explicitly.'
					: 'Preparation was interrupted. Start deployment again explicitly.',
			}
			this.storage.saveProject(project)
		}
		return {
			sessionId: id,
			projectRoot: project.projectRoot,
			connection: credential?.connection ?? config.connection ?? null,
			credential: { available: !!credential && credential.expiresAt > this.now(), expiresAt: credential?.expiresAt ?? null },
			pairing: this.pairings.get(id)
				?? (credential ? { status: 'connected' } : project.recoveryRequired ? { status: 'recovery_required', message: RECOVERY } : null),
			previewUrl: config.previewUrl ?? null,
			deployment: project.deployment,
		}
	}

	preview(id: string, url: string | null): BuilderPlatformStatus {
		const project = this.project(id)
		const { previewUrl: _old, ...config } = this.storage.config(project)
		this.storage.saveConfig(project, { ...config, ...(url === null ? {} : { previewUrl: parseBuilderPreviewUrl(url) }) })
		return this.status(id)
	}

	private operation(id: string): AbortController {
		if (this.stopped.signal.aborted) throw new PlatformError('Daemon is stopping')
		if (this.operations.has(id)) throw new PlatformError('A project operation is already active')
		const controller = new AbortController()
		this.operations.set(id, controller)
		return controller
	}

	private signal(controller: AbortController): AbortSignal {
		return AbortSignal.any([controller.signal, this.stopped.signal])
	}
	private remote(signal: AbortSignal): PlatformRemote {
		return new PlatformRemote(this.fetcher, signal)
	}

	async connect(id: string, requestedOrigin: string): Promise<BuilderPlatformStatus> {
		const project = this.project(id)
		if (this.storage.credential(id) || this.storage.config(project).connection || project.recoveryRequired) {
			throw new PlatformError('An existing connection requires explicit disconnect before pairing again')
		}
		const controller = this.operation(id)
		const signal = this.signal(controller)
		try {
			const remote = this.remote(signal)
			const pins = await remote.discover(parseBuilderOrigin(requestedOrigin, 'Control origin'))
			const approval = randomBytes(32).toString('base64url')
			const redemptionVerifier = randomBytes(32).toString('base64url')
			const challenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')
			const label = `Local builder ${id}`.slice(0, 200)
			const input: StartDeviceAuthorizationInput = {
				app: 'vozka',
				label,
				permissions: [...PERMISSIONS],
				keyLifetimeSeconds: KEY_LIFETIME,
				approvalChallenge: challenge(approval),
				redemptionChallenge: challenge(redemptionVerifier),
			}
			const started = parseStartDeviceAuthorizationResult(await remote.json(`${pins.iamIssuer}/auth/device/start`, input))
			if (!started?.ok || started.expiresAt <= this.now() || started.expiresAt > this.now() + 600) {
				throw new PlatformError('IAM refused or returned an invalid pairing attempt')
			}
			const fragment = new URLSearchParams({ attempt: started.attemptId, approval, expires: String(started.expiresAt) })
			this.pairings.set(id, { status: 'pending', authorizationUrl: `${pins.controlOrigin}/builder/connect#${fragment}`, expiresAt: started.expiresAt })
			void this.pair(project, pins, { attemptId: started.attemptId, redemptionVerifier }, started.expiresAt, label, remote, signal)
				.catch(() => {
					if (!signal.aborted) {
						this.pairings.set(id, {
							status: project.recoveryRequired ? 'recovery_required' : 'failed',
							message: project.recoveryRequired ? RECOVERY : 'Pairing failed. Check the installation and start a new attempt.',
						})
					}
				}).finally(() => {
					if (this.operations.get(id) === controller) this.operations.delete(id)
				})
			return this.status(id)
		} catch (error) {
			this.operations.delete(id)
			throw error instanceof PlatformError ? error : new PlatformError('Unable to start pairing')
		}
	}

	private validateConsent(consent: DeviceAuthorizationConsent, label: string): void {
		if (
			consent.app !== 'vozka' || consent.label !== label || consent.scope.type !== 'app'
			|| !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(consent.scope.value)
			|| [...consent.permissions].sort().join(',') !== [...PERMISSIONS].sort().join(',') || consent.keyExpiresAt <= this.now()
			|| consent.keyExpiresAt > this.now() + KEY_LIFETIME
		) {
			throw new PlatformError('IAM consent does not match the requested app-scoped authorization')
		}
	}

	private async pair(
		project: ProjectRecord,
		pins: { controlOrigin: string; iamIssuer: string },
		proof: { attemptId: string; redemptionVerifier: string },
		expiresAt: number,
		label: string,
		remote: PlatformRemote,
		signal: AbortSignal,
	): Promise<void> {
		const id = project.sessionId
		for (let poll = 0; poll < 200 && this.now() < expiresAt; poll++) {
			await this.sleep(3000, signal)
			signal.throwIfAborted()
			const result = parsePollDeviceAuthorizationResult(await remote.json(`${pins.iamIssuer}/auth/device/poll`, proof))
			signal.throwIfAborted()
			if (!result) throw new PlatformError('Invalid IAM pairing response')
			if (!result.ok) {
				if (result.reason === 'slow_down') continue
				throw new PlatformError('Pairing attempt was not found')
			}
			if (result.status === 'pending') continue
			if (result.status === 'issued') {
				project.recoveryRequired = true
				this.storage.saveProject(project)
				this.pairings.set(id, { status: 'recovery_required', message: RECOVERY })
				return
			}
			if (result.status !== 'approved') {
				this.pairings.set(
					id,
					result.status === 'expired' || result.status === 'cancelled'
						? { status: result.status }
						: { status: 'failed', message: 'Authorization was denied or the approving account lost access.' },
				)
				return
			}
			const consent = result.consent
			this.validateConsent(consent, label)
			this.pairings.set(id, { status: 'approved' })
			// Persist ambiguity before the one-time exchange; a lost response must never cause a remint.
			project.recoveryRequired = true
			this.storage.saveProject(project)
			const exchanged = parseExchangeDeviceAuthorizationResult(
				await remote.json(`${pins.iamIssuer}/auth/device/exchange`, { ...proof, consentId: consent.consentId }),
			)
			if (!exchanged?.ok) throw new PlatformError(RECOVERY)
			if (
				exchanged.receipt.attemptId !== proof.attemptId || exchanged.receipt.revokedAt !== null
				|| JSON.stringify(exchanged.receipt.consent) !== JSON.stringify(consent)
			) throw new PlatformError(RECOVERY)
			const client = remote.controlForReceipt(pins.controlOrigin, exchanged.token)
			const receipt = parseBuilderConnectionReceipt(await client.builderConnections.getReceipt({ attemptId: proof.attemptId }))
			if (receipt.attemptId !== proof.attemptId || receipt.provider !== 'zerops' || receipt.app.id !== consent.scope.value) {
				throw new PlatformError(RECOVERY)
			}
			signal.throwIfAborted()
			const connection = { ...pins, receipt }
			this.storage.saveCredential(id, { connection, token: exchanged.token, expiresAt: consent.keyExpiresAt })
			this.storage.saveConfig(project, { ...this.storage.config(project), connection })
			project.recoveryRequired = false
			this.storage.saveProject(project)
			this.pairings.set(id, { status: 'connected' })
			return
		}
		this.pairings.set(id, { status: 'expired' })
	}

	disconnect(id: string): BuilderPlatformStatus {
		const project = this.project(id)
		if (activeDeployment(project)) {
			throw new PlatformError('Deployment is still active or awaiting confirmation. Keep the connection until its outcome is known.')
		}
		this.operations.get(id)?.abort()
		this.operations.delete(id)
		this.storage.removeCredential(id)
		const { connection: _old, ...config } = this.storage.config(project)
		this.storage.saveConfig(project, config)
		project.recoveryRequired = false
		this.storage.saveProject(project)
		this.pairings.set(id, { status: 'cancelled' })
		return this.status(id)
	}

	deploy(id: string): BuilderPlatformStatus {
		const project = this.project(id)
		const credential = this.storage.credential(id)
		if (!credential || credential.expiresAt <= this.now()) throw new PlatformError('Connect the project with a valid credential before deploying')
		if (activeDeployment(project)) {
			throw new PlatformError('A deploy run is already active')
		}
		const key = this.targetKey(credential)
		this.restoreReservations()
		if (this.targets.has(key)) throw new PlatformError('This application environment already has a local operation')
		const controller = this.operation(id)
		this.targets.set(key, id)
		project.deployment = {
			status: 'preparing',
			runId: null,
			commitSha: null,
			appUrl: null,
			consoleUrl: credential.connection.controlOrigin,
			message: 'Verifying committed source and compiling the application.',
		}
		this.storage.saveProject(project)
		this.backgroundDeploy(project, credential, controller, key, false)
		return this.status(id)
	}

	private targetKey(credential: StoredCredential): string {
		return JSON.stringify([credential.connection.controlOrigin, credential.connection.receipt.app.id, credential.connection.receipt.environment.env])
	}

	private restoreReservations(): void {
		const reservations = new Map<string, string>()
		for (const project of this.storage.projects()) {
			if (!activeDeployment(project)) continue
			const credential = this.storage.credential(project.sessionId)
			if (!credential) throw new PlatformError('An active deployment has missing custody. Restore its connection before starting another deployment.')
			const key = this.targetKey(credential)
			const owner = reservations.get(key)
			if (owner && owner !== project.sessionId) {
				throw new PlatformError('Multiple saved runs reserve this application environment. Resolve them in the console.')
			}
			reservations.set(key, project.sessionId)
		}
		this.targets.clear()
		for (const [key, owner] of reservations) this.targets.set(key, owner)
	}

	private resume(project: ProjectRecord, credential: StoredCredential): void {
		const key = this.targetKey(credential)
		const owner = this.targets.get(key)
		if ((owner !== undefined && owner !== project.sessionId) || this.stopped.signal.aborted) return
		const controller = this.operation(project.sessionId)
		this.targets.set(key, project.sessionId)
		this.backgroundDeploy(project, credential, controller, key, true)
	}

	private backgroundDeploy(project: ProjectRecord, credential: StoredCredential, controller: AbortController, key: string, resume: boolean): void {
		const signal = this.signal(controller)
		void (resume ? this.monitor(project, credential, signal) : this.prepare(project, credential, signal))
			.catch((error: unknown) => {
				if (signal.aborted) return
				if (project.deployment) {
					const unobserved = error instanceof ObservationError || (!project.deployment.runId && project.deployment.commitSha !== null)
					project.deployment = {
						...project.deployment,
						status: unobserved ? project.deployment.status : 'failed',
						appUrl: null,
						message: unobserved
							? project.deployment.runId
								? 'Run observation is unavailable. The remote outcome is unknown; status will retry monitoring.'
								: 'Deployment submission outcome is unknown. Inspect Control; this target remains reserved and cannot be retriggered.'
							: error instanceof PlatformError
							? error.message
							: 'Deployment failed. Check the platform console and local source.',
					}
					this.storage.saveProject(project)
				}
			}).catch(() => {}).finally(() => {
				if (!activeDeployment(project)) this.targets.delete(key)
				if (this.operations.get(project.sessionId) === controller) this.operations.delete(project.sessionId)
			})
	}

	private async prepare(project: ProjectRecord, credential: StoredCredential, signal: AbortSignal): Promise<void> {
		const { receipt } = credential.connection
		const app = receipt.app
		const env = receipt.environment.env
		if (receipt.provider !== 'zerops') throw new PlatformError('Unsupported connection provider')
		const sha = await verifySource(project.projectRoot, app, signal)
		mkdirSync(this.storage.stateDir, { recursive: true, mode: 0o700 })
		const manifest = await compileProject(project.projectRoot, env, app.id, this.storage.stateDir, signal)
		if (await verifySource(project.projectRoot, app, signal) !== sha) throw new PlatformError('Source changed during compilation')
		const client = this.remote(signal).control(credential)
		const currentApp = parseBuilderConnectionReceipt({ ...receipt, app: await client.apps.get({ appId: app.id }) }).app
		if (
			currentApp.id !== app.id || repositoryIdentity(currentApp.repoUrl) !== repositoryIdentity(app.repoUrl) || currentApp.workerDir !== app.workerDir
			|| currentApp.configPath !== app.configPath || currentApp.buildCmd !== app.buildCmd || currentApp.defaultBranch !== app.defaultBranch
			|| currentApp.githubConnectionId !== app.githubConnectionId
			|| currentApp.githubInstallationId !== app.githubInstallationId
		) throw new PlatformError('The approved application source changed in Control; reconnect explicitly')
		const current = parseEnvironments(await client.apps.environments.list({ appId: app.id })).find((item) => item.env === env)
		if (
			current
			&& (current.appId !== app.id || current.provider !== 'zerops' || current.target.provider !== 'zerops' || current.artifact.provider !== 'zerops')
		) throw new PlatformError('Environment provider or application does not match the connection')
		const placement = current ?? receipt.environment
		if (!placement.namespaceId) throw new PlatformError('Select a deployment namespace in the platform console before deploying')
		signal.throwIfAborted()
		const updated = parseEnvironments({
			items: [
				await client.apps.environments.put({
					appId: app.id,
					env,
					environment: {
						namespaceId: placement.namespaceId,
						domain: placement.domain,
						publicOrigin: placement.publicOrigin,
						triggerRef: placement.triggerRef,
						target: current?.target ?? { provider: 'zerops', version: zeropsStoredTargetCodec.version, payload: {} },
						artifact: { provider: 'zerops', version: zeropsArtifactCodec.version, payload: zeropsArtifactCodec.encode(manifest) },
					},
				}),
			],
		})[0]
		if (!updated || updated.appId !== app.id || updated.env !== env || updated.provider !== 'zerops') {
			throw new PlatformError('Control returned a mismatched environment')
		}
		signal.throwIfAborted()
		// Once triggering starts the response may be lost. Never retry this write automatically.
		project.deployment = {
			status: 'preparing',
			runId: null,
			commitSha: sha,
			message: 'Submitting exact commit. If interrupted, inspect Control before retrying.',
			appUrl: null,
			consoleUrl: credential.connection.controlOrigin,
		}
		this.storage.saveProject(project)
		const run = parseRun(await client.deploy({ appId: app.id, env, ref: sha }))
		if (run.appId !== app.id || run.env !== env || run.ref !== sha) throw new PlatformError('Control returned a different deployment target')
		project.deployment = { ...project.deployment, status: 'pending', runId: run.id, message: 'Deployment submitted; waiting for the platform run.' }
		this.storage.saveProject(project)
		await this.monitor(project, credential, signal)
	}

	private async monitor(project: ProjectRecord, credential: StoredCredential, signal: AbortSignal): Promise<void> {
		const client = this.remote(signal).control(credential)
		const receipt = credential.connection.receipt
		const deadline = this.now() + 3600
		for (let poll = 0; poll < 1200 && this.now() < deadline; poll++) {
			const deployment = project.deployment
			if (!deployment?.runId || !deployment.commitSha) throw new PlatformError('Saved deployment is missing its run or commit')
			signal.throwIfAborted()
			const run = await client.runs.get({ runId: deployment.runId }).then(parseRun).catch(() => {
				throw new ObservationError('Run observation unavailable')
			})
			if (run.id !== deployment.runId || run.appId !== receipt.app.id || run.env !== receipt.environment.env || run.ref !== deployment.commitSha) {
				throw new ObservationError('Platform returned a different run')
			}
			const terminal = run.status === 'succeeded' || run.status === 'failed'
			if (terminal && run.commitSha !== deployment.commitSha) throw new PlatformError('Completed run commit does not match the requested SHA')
			let appUrl: string | null = null
			if (run.status === 'succeeded') {
				try {
					const environment = parseEnvironments(await client.apps.environments.list({ appId: receipt.app.id })).find((item) =>
						item.appId === receipt.app.id && item.env === receipt.environment.env && item.provider === 'zerops'
					)
					if (environment?.publicOrigin) appUrl = parseBuilderPreviewUrl(environment.publicOrigin)
					else if (environment?.domain) appUrl = parseBuilderPreviewUrl(`https://${environment.domain}`)
				} catch {
					// URL metadata is optional; it cannot change an already verified terminal run result.
				}
			}
			signal.throwIfAborted()
			project.deployment = {
				...deployment,
				status: run.status,
				appUrl,
				message: run.status === 'succeeded'
					? 'Deployment succeeded. The configured URL has not been checked for reachability.'
					: run.status === 'failed'
					? 'Platform deployment failed. See the console for details.'
					: 'Platform deployment is in progress.',
			}
			this.storage.saveProject(project)
			if (terminal) return
			await this.sleep(3000, signal)
		}
		throw new ObservationError('Deployment polling timed out. Inspect the saved run in the platform console.')
	}
}
