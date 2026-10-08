import type { StartGitHubSourceConnectionRequest, StartGitHubSourceConnectionResponse } from '@fabrika/control-contract'
import { buildGitHubAppManifest, exchangeGitHubAppManifestCode } from '@fabrika/github-app'
import { githubAppCredentialSecretLabel, githubManifestStateSecretLabel, type GitHubSetupAttempt } from '../github-connection-store'
import { vault } from '../services'
import { encodeGitHubAppCredential } from '../source/credentials'
import { uuidv7 } from '../uuid'
import { advanceWithDeadline, errorForPhase } from './configuration'
import {
	abortable,
	audit,
	randomToken,
	requireControlOrigin,
	requireHuman,
	requireSameOrigin,
	serverDeadline,
	sha256,
	type SourceConnectionWorkflowDeps,
	throwIfAborted,
} from './context'
import { SourceConnectionWorkflowError } from './errors'
import { MANIFEST_PATH } from './status'

const CALLBACK_PATH = '/api/source/github/callback'

const DASHBOARD_PATH = '/settings/source'

const SETUP_TTL_SECONDS = 10 * 60

const MAX_CONNECTION_ID_LENGTH = 128

const MAX_CALLBACK_QUERY_LENGTH = 1024

const PERSISTENCE_DEADLINE_MS = 30_000

const FAILURE_SETTLE_ATTEMPTS = 10

const FAILURE_SETTLE_DELAY_MS = 25

const STATE_BYTES = 32

export async function startSourceConnection(
	deps: SourceConnectionWorkflowDeps,
	input: StartGitHubSourceConnectionRequest,
): Promise<StartGitHubSourceConnectionResponse> {
	const principalId = requireHuman(deps.auth)
	const origin = requireSameOrigin(deps.env, deps.request)
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(input.organization) || input.appName.length < 1 || input.appName.length > 100) {
		throw new SourceConnectionWorkflowError(400)
	}
	if (input.visibility !== 'private') throw new SourceConnectionWorkflowError(400)
	const owner = input.organization.toLowerCase()
	const repositories = canonicalRepositories(input.organization, input.repositories)
	const attemptId = uuidv7()
	buildManifest(owner, input.appName, origin, attemptId)
	// The App key has nowhere to go without the vault, and GitHub hands it over exactly once.
	if (!deps.source.available || deps.env.FABRIKA_CONTROL_VAULT_KEY === undefined) throw new SourceConnectionWorkflowError(503)
	const [workflow, sameOwner] = await Promise.all([
		deps.env.REPOSITORIES.githubConnections.getWorkflowAttempt(),
		deps.env.REPOSITORIES.githubConnections.getConnectionByOwner(owner),
	])
	if (workflow !== null || sameOwner !== null) throw new SourceConnectionWorkflowError(409)
	const state = randomToken(STATE_BYTES, deps.randomBytes)
	const stateHash = await sha256(state)
	const secretVault = await vault(deps.env)
	const prepared = await secretVault.prepareSecret('platform', githubManifestStateSecretLabel(attemptId), state)
	const now = deps.now?.() ?? Math.floor(Date.now() / 1000)
	try {
		await deps.env.REPOSITORIES.githubConnections.beginAttemptWithManifestState({
			id: attemptId,
			stateHash,
			initiatedBy: principalId,
			expectedOrigin: origin,
			desiredOwner: owner,
			desiredAppName: input.appName,
			desiredPublic: false,
			requestedRepositories: repositories.map((repository) => `${repository.owner}/${repository.name}`),
			expiresAt: now + SETUP_TTL_SECONDS,
		}, prepared)
	} catch {
		throw new SourceConnectionWorkflowError(409)
	}
	await audit(deps.auth, 'source.connection.start', attemptId)
	return { connectionId: attemptId, continuePath: `${MANIFEST_PATH}/${encodeURIComponent(attemptId)}` }
}

export async function manifestHandoff(deps: SourceConnectionWorkflowDeps, connectionId: string): Promise<Response> {
	const principalId = requireHuman(deps.auth)
	const origin = requireControlOrigin(deps.env)
	if (connectionId === '' || connectionId.length > MAX_CONNECTION_ID_LENGTH || new URL(deps.request.url).search !== '') {
		throw new SourceConnectionWorkflowError(400)
	}
	await deps.env.REPOSITORIES.githubConnections.reapExpiredAttempt()
	const current = await deps.env.REPOSITORIES.githubConnections.getAttempt(connectionId)
	if (
		current === null || current.status !== 'active' || current.phase !== 'awaiting_manifest_callback'
		|| current.initiatedBy !== principalId || current.expectedOrigin !== origin || current.manifestStateSecretRef === null
	) throw new SourceConnectionWorkflowError(404)
	const attempt = await deps.env.REPOSITORIES.githubConnections.renewManifestHandoff(
		current.id,
		current.version,
		principalId,
		origin,
		(deps.now?.() ?? Math.floor(Date.now() / 1000)) + SETUP_TTL_SECONDS,
	)
	if (attempt === null || attempt.manifestStateSecretRef === null || attempt.stateHash === null) {
		throw new SourceConnectionWorkflowError(409)
	}
	const secretVault = await vault(deps.env)
	let state: string
	try {
		state = await secretVault.getSecretForPurpose(attempt.manifestStateSecretRef, {
			scope: 'platform',
			label: githubManifestStateSecretLabel(attempt.id),
		})
	} catch {
		throw new SourceConnectionWorkflowError(409)
	}
	if (await sha256(state) !== attempt.stateHash) throw new SourceConnectionWorkflowError(409)
	const manifest = buildManifest(attempt.desiredOwner, attempt.desiredAppName, origin, attempt.id)
	const action = `https://github.com/organizations/${encodeURIComponent(attempt.desiredOwner)}/settings/apps/new?state=${encodeURIComponent(state)}`
	return secureHtml(manifestForm(action, JSON.stringify(manifest)))
}

export async function manifestCallback(deps: SourceConnectionWorkflowDeps): Promise<Response> {
	const principalId = requireHuman(deps.auth)
	const origin = requireControlOrigin(deps.env)
	const url = new URL(deps.request.url)
	if (url.search.length > MAX_CALLBACK_QUERY_LENGTH) throw new SourceConnectionWorkflowError(400)
	if ([...url.searchParams.keys()].some((key) => key !== 'state' && key !== 'code')) throw new SourceConnectionWorkflowError(400)
	const state = exactQueryValue(deps.request, 'state', 256)
	const code = exactQueryValue(deps.request, 'code', 256)
	if (state === null || code === null) throw new SourceConnectionWorkflowError(400)
	const stateHash = await sha256(state)
	const claimed = await deps.env.REPOSITORIES.githubConnections.claimCallback(stateHash, principalId)
	if (claimed === null || claimed.expectedOrigin !== origin) throw new SourceConnectionWorkflowError(409)

	let created: Awaited<ReturnType<typeof exchangeGitHubAppManifestCode>>
	try {
		created = await (deps.exchangeManifest ?? exchangeGitHubAppManifestCode)(code, {
			...(deps.githubFetch === undefined ? {} : { fetch: deps.githubFetch }),
			signal: deps.request.signal,
		})
	} catch {
		await deps.env.REPOSITORIES.githubConnections.markFailed(claimed.id, claimed.version, 'manifest_exchange').catch(() => null)
		throwIfAborted(deps.request.signal)
		// Names the phase and NOTHING of the cause on purpose: this call carries the one-time manifest
		// code, and a rejected fetch can carry the URL it was made against.
		throw new SourceConnectionWorkflowError(502, 'the GitHub App manifest exchange failed')
	}

	try {
		// ADR-0029: the key is in the vault, in the same transaction as the checkpoint, before anything reports success.
		const persistence = serverDeadline(PERSISTENCE_DEADLINE_MS)
		let stored: GitHubSetupAttempt | null
		try {
			const credential = encodeGitHubAppCredential({ appId: String(created.id), privateKeyPem: created.pem })
			const secretVault = await abortable(vault(deps.env), persistence.signal)
			const prepared = await abortable(
				secretVault.prepareSecret('platform', githubAppCredentialSecretLabel(claimed.id), credential),
				persistence.signal,
			)
			stored = await abortable(
				deps.env.REPOSITORIES.githubConnections.storeSecretAndCheckpoint(
					claimed.id,
					claimed.version,
					'exchange_claimed',
					'credential_stored',
					'app-credential',
					prepared,
				),
				persistence.signal,
			)
		} finally {
			persistence.dispose()
		}
		if (stored === null) throw new Error('checkpoint failed')
		await advanceWithDeadline(deps, stored)
	} catch {
		const disposition = await settleCallbackFailure(deps, claimed)
		throwIfAborted(deps.request.signal)
		if (disposition === 'failed') throw new SourceConnectionWorkflowError(503)
	}
	return cleanRedirect(DASHBOARD_PATH)
}

function exactQueryValue(request: Request, key: string, maxLength: number): string | null {
	const values = new URL(request.url).searchParams.getAll(key)
	if (values.length !== 1) return null
	const value = values[0]
	return value === undefined || value === '' || value.length > maxLength ? null : value
}

function canonicalRepositories(
	organization: string,
	repositories: readonly { readonly owner: string; readonly name: string }[],
): { readonly owner: string; readonly name: string }[] {
	const owner = organization.toLowerCase()
	const unique = new Map<string, { readonly owner: string; readonly name: string }>()
	for (const repository of repositories) {
		if (repository.owner.toLowerCase() !== owner) throw new SourceConnectionWorkflowError(400, 'repositories must belong to the App organization')
		if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(repository.owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repository.name)) {
			throw new SourceConnectionWorkflowError(400)
		}
		const normalized = { owner, name: repository.name.toLowerCase() }
		unique.set(`${normalized.owner}/${normalized.name}`, normalized)
	}
	return [...unique.values()].sort((left, right) => `${left.owner}/${left.name}`.localeCompare(`${right.owner}/${right.name}`))
}

function manifestForm(action: string, manifest: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Connect GitHub</title></head><body><form method="post" action="${
		html(action)
	}"><input type="hidden" name="manifest" value="${html(manifest)}"><button type="submit">Continue to GitHub</button></form></body></html>`
}

function buildManifest(organization: string, appName: string, origin: string, connectionId: string) {
	try {
		return buildGitHubAppManifest({
			organization,
			appName,
			homepageUrl: origin,
			webhookUrl: `${origin}/webhooks/github/${encodeURIComponent(connectionId)}`,
			redirectUrl: `${origin}${CALLBACK_PATH}`,
			public: false,
		})
	} catch {
		throw new SourceConnectionWorkflowError(400)
	}
}

async function settleCallbackFailure(
	deps: SourceConnectionWorkflowDeps,
	claimed: GitHubSetupAttempt,
): Promise<'failed' | 'repair_required'> {
	for (let attemptNumber = 0; attemptNumber < FAILURE_SETTLE_ATTEMPTS; attemptNumber++) {
		const current = await deps.env.REPOSITORIES.githubConnections.getAttempt(claimed.id).catch(() => undefined)
		if (current === undefined) {
			await delay(FAILURE_SETTLE_DELAY_MS)
			continue
		}
		if (current === null || current.status === 'failed') return 'failed'
		if (current.status === 'repair_required') return 'repair_required'
		if (current.status !== 'active') throw new SourceConnectionWorkflowError(503)
		if (current.appCredentialRef !== null) {
			const repair = await deps.env.REPOSITORIES.githubConnections.markRepairRequired(
				current.id,
				current.version,
				errorForPhase(current.phase),
			).catch(() => null)
			if (repair !== null) return 'repair_required'
		} else {
			const failed = await deps.env.REPOSITORIES.githubConnections.markFailed(
				current.id,
				current.version,
				'credential_persistence',
			).catch(() => null)
			if (failed !== null) return 'failed'
		}
		await delay(FAILURE_SETTLE_DELAY_MS)
	}
	throw new SourceConnectionWorkflowError(503)
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function html(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function secureHtml(body: string): Response {
	return new Response(body, {
		headers: {
			'cache-control': 'no-store',
			'content-security-policy': "default-src 'none'; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'",
			'content-type': 'text/html; charset=utf-8',
			'referrer-policy': 'no-referrer',
			'x-content-type-options': 'nosniff',
		},
	})
}

function cleanRedirect(location: string): Response {
	return new Response(null, {
		status: 303,
		headers: {
			'cache-control': 'no-store',
			location,
			'referrer-policy': 'no-referrer',
		},
	})
}
