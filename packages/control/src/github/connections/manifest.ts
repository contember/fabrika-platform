import type {
	GitHubSourceConnectionCancelDto,
	GitHubSourceConnectionHandoffDto,
	GitHubSourceConnectionHandoffInput,
	StartGitHubSourceConnectionRequest,
	StartGitHubSourceConnectionResponse,
} from '@fabrika/control-contract'
import { buildGitHubAppManifest, exchangeGitHubAppManifestCode } from '@fabrika/github-app'
import { uuidv7 } from '@fabrika/platform'
import { readBoundedText } from '../../http'
import { vault } from '../../services'
import { cleanRedirect, consoleRedirect, handoffResult, secureHtml } from './browser'
import { advanceWithDeadline, settleFailedStep } from './configuration'
import {
	abortable,
	audit,
	randomToken,
	requireControlOrigin,
	requireHuman,
	serverDeadline,
	sha256,
	type SourceConnectionRequestDeps,
	type SourceConnectionWorkflowDeps,
	throwIfAborted,
} from './context'
import { encodeGitHubAppCredential } from './credentials'
import { appOwnerFailed, SourceConnectionWorkflowError } from './errors'
import { handoffOpeningCsp, handoffOpeningHtml, manifestHandoffCsp, manifestHandoffHtml, type ManifestHandoffMode } from './handoff-page'
import { type GitHubSetupAttempt } from './model'
import { githubAppCredentialSecretLabel, githubManifestStateSecretLabel } from './secrets'
import { HANDOFF_CALLBACK_PATH, HANDOFF_PATH, HANDOFF_SETUP_PATH, installationUrl, MANIFEST_PATH, SETUP_PATH } from './status'

const CALLBACK_PATH = '/api/source/github/callback'

const SETUP_TTL_SECONDS = 10 * 60

/**
 * How long a handoff link stays usable unless the administrator asks for another span. While it is, no other setup can
 * start, so the default is short; a cancel ends it sooner.
 */
export const HANDOFF_DEFAULT_TTL_SECONDS = 60 * 60
export const HANDOFF_MIN_TTL_SECONDS = 10 * 60
export const HANDOFF_MAX_TTL_SECONDS = 24 * 60 * 60

const HANDOFF_TOKEN_BYTES = 32

const MAX_CONNECTION_ID_LENGTH = 128

const MAX_CALLBACK_QUERY_LENGTH = 1024

const PERSISTENCE_DEADLINE_MS = 30_000

const FAILURE_SETTLE_ATTEMPTS = 10

const FAILURE_SETTLE_DELAY_MS = 25

const STATE_BYTES = 32

const NONCE_BYTES = 16

export async function startSourceConnection(
	deps: SourceConnectionWorkflowDeps,
	input: StartGitHubSourceConnectionRequest,
): Promise<StartGitHubSourceConnectionResponse> {
	const principalId = requireHuman(deps.auth)
	const origin = requireControlOrigin(deps.env)
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(input.organization) || input.appName.length < 1 || input.appName.length > 100) {
		throw new SourceConnectionWorkflowError(400)
	}
	if (input.visibility !== 'private') throw new SourceConnectionWorkflowError(400)
	const ownerType = input.ownerType ?? 'Organization'
	const owner = input.organization.toLowerCase()
	const repositories = canonicalRepositories(input.organization, input.repositories)
	const attemptId = uuidv7()
	buildManifest(owner, input.appName, origin, attemptId, 'console')
	// The App key has nowhere to go without the vault, and GitHub hands it over exactly once.
	if (deps.env.FABRIKA_CONTROL_VAULT_KEY === undefined) throw new SourceConnectionWorkflowError(503)
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
			desiredOwnerType: ownerType,
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
	if (attempt === null) throw new SourceConnectionWorkflowError(409)
	return await manifestPage(deps, attempt, origin, 'console')
}

/**
 * Mint the link an administrator hands to the owner of the GitHub account (an organization's owner, or the person of a
 * personal account), who creates and installs the App from their own browser without a console session. The link is
 * bound to this attempt, not to a browser: whoever opens it can post the manifest, and GitHub creates the App only for
 * someone allowed to on that account; the callback refuses an App on any other. A new link replaces the one before it.
 * The token is shown once; only its hash is kept.
 */
export async function mintSourceConnectionHandoff(
	deps: SourceConnectionWorkflowDeps,
	input: GitHubSourceConnectionHandoffInput,
): Promise<GitHubSourceConnectionHandoffDto> {
	const principalId = requireHuman(deps.auth)
	const origin = requireControlOrigin(deps.env)
	const { connectionId } = input
	const ttl = input.expiresInSeconds ?? HANDOFF_DEFAULT_TTL_SECONDS
	if (connectionId === '' || connectionId.length > MAX_CONNECTION_ID_LENGTH) throw new SourceConnectionWorkflowError(400)
	if (!Number.isSafeInteger(ttl) || ttl < HANDOFF_MIN_TTL_SECONDS || ttl > HANDOFF_MAX_TTL_SECONDS) {
		throw new SourceConnectionWorkflowError(400, 'a handoff link lasts from 10 minutes to 24 hours')
	}
	await deps.env.REPOSITORIES.githubConnections.reapExpiredAttempt()
	const current = await deps.env.REPOSITORIES.githubConnections.getAttempt(connectionId)
	if (
		current === null || current.status !== 'active' || current.phase !== 'awaiting_manifest_callback'
		|| current.initiatedBy !== principalId || current.expectedOrigin !== origin || current.manifestStateSecretRef === null
	) throw new SourceConnectionWorkflowError(404)
	const token = randomToken(HANDOFF_TOKEN_BYTES, deps.randomBytes)
	// A fresh manifest state too, so a page opened with an earlier link, or the console's, can no longer finish it.
	const state = randomToken(STATE_BYTES, deps.randomBytes)
	const expiresAt = (deps.now?.() ?? Math.floor(Date.now() / 1000)) + ttl
	const secretVault = await vault(deps.env)
	const attempt = await deps.env.REPOSITORIES.githubConnections.mintHandoff({
		attempt: current,
		principalId,
		expectedOrigin: origin,
		tokenHash: await sha256(token),
		stateHash: await sha256(state),
		state: await secretVault.prepareSecret('platform', githubManifestStateSecretLabel(current.id), state),
		expiresAt,
	})
	if (attempt === null) throw new SourceConnectionWorkflowError(409)
	await audit(deps.auth, 'source.connection.handoff', attempt.id)
	// The token rides in the fragment, which no browser sends: it reaches no request log, on either cloud.
	return { connectionId: attempt.id, url: `${origin}${HANDOFF_PATH}/${encodeURIComponent(attempt.id)}#${token}`, expiresAt }
}

/**
 * Cancel a setup that still waits for GitHub to create the App, so a mistyped organization or a link handed to the wrong
 * person does not hold the one setup slot until it expires. Any person who manages source connections may cancel it,
 * not only the one who started it. After the App exists, the setup is finished or repaired instead.
 */
export async function cancelSourceConnection(deps: SourceConnectionWorkflowDeps, connectionId: string): Promise<GitHubSourceConnectionCancelDto> {
	requireHuman(deps.auth)
	if (connectionId === '' || connectionId.length > MAX_CONNECTION_ID_LENGTH) throw new SourceConnectionWorkflowError(400)
	const current = await deps.env.REPOSITORIES.githubConnections.getAttempt(connectionId)
	if (current === null || current.status !== 'active' || current.phase !== 'awaiting_manifest_callback') {
		throw new SourceConnectionWorkflowError(404)
	}
	const cancelled = await deps.env.REPOSITORIES.githubConnections.cancelAwaitingAttempt(current)
	if (cancelled === null) throw new SourceConnectionWorkflowError(409)
	await audit(deps.auth, 'source.connection.cancel', cancelled.id)
	return { connectionId: cancelled.id }
}

/**
 * What the handoff link opens: a page with no secret in it, which reads the token from the fragment and posts it back.
 * It reads nothing stored, so it says nothing about the attempt.
 */
export function handoffOpening(deps: SourceConnectionRequestDeps, connectionId: string): Response {
	// Any query is ignored, not refused: a mail or chat tool may add tracking parameters, and the page reads none.
	if (connectionId === '' || connectionId.length > MAX_CONNECTION_ID_LENGTH) {
		throw new SourceConnectionWorkflowError(400)
	}
	const nonce = randomToken(NONCE_BYTES, deps.randomBytes)
	return secureHtml(handoffOpeningHtml(nonce), handoffOpeningCsp(nonce))
}

/** The manifest page for a browser that came through a handoff link: the posted token, not a session, admits it. */
export async function handedOffManifest(deps: SourceConnectionRequestDeps, connectionId: string): Promise<Response> {
	const origin = requireControlOrigin(deps.env)
	if (connectionId === '' || connectionId.length > MAX_CONNECTION_ID_LENGTH || new URL(deps.request.url).search !== '') {
		throw new SourceConnectionWorkflowError(400)
	}
	const token = await postedToken(deps.request)
	if (token === null) throw new SourceConnectionWorkflowError(400)
	await deps.env.REPOSITORIES.githubConnections.reapExpiredAttempt()
	const attempt = await deps.env.REPOSITORIES.githubConnections.getAttempt(connectionId)
	const now = deps.now?.() ?? Math.floor(Date.now() / 1000)
	// One answer for an unknown attempt, a wrong or replaced token, an expired link and a used one: the link is spent
	// once the callback claimed the state, because the attempt has left this phase.
	if (
		attempt === null || attempt.status !== 'active' || attempt.phase !== 'awaiting_manifest_callback' || attempt.expiresAt <= now
		|| attempt.expectedOrigin !== origin || attempt.handoffTokenHash === null || await sha256(token) !== attempt.handoffTokenHash
	) throw new SourceConnectionWorkflowError(404, 'this link is not valid any more; ask your administrator for a new one')
	return await manifestPage(deps, attempt, origin, 'handoff')
}

async function manifestPage(
	deps: SourceConnectionRequestDeps,
	attempt: GitHubSetupAttempt,
	origin: string,
	mode: ManifestHandoffMode,
): Promise<Response> {
	if (attempt.manifestStateSecretRef === null || attempt.stateHash === null) throw new SourceConnectionWorkflowError(409)
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
	const manifest = buildManifest(attempt.desiredOwner, attempt.desiredAppName, origin, attempt.id, mode)
	const nonce = randomToken(NONCE_BYTES, deps.randomBytes)
	return secureHtml(
		manifestHandoffHtml({
			action: `${appCreationUrl(attempt)}?state=${encodeURIComponent(state)}`,
			manifest: JSON.stringify(manifest),
			owner: attempt.desiredOwner,
			ownerType: attempt.desiredOwnerType,
			appName: attempt.desiredAppName,
			nonce,
			mode,
		}),
		manifestHandoffCsp(nonce),
	)
}

/** GitHub creates an organization's App under the organization's settings, a personal account's under the signed-in account's. */
function appCreationUrl(attempt: GitHubSetupAttempt): string {
	if (attempt.desiredOwnerType === 'User') return 'https://github.com/settings/apps/new'
	return `https://github.com/organizations/${encodeURIComponent(attempt.desiredOwner)}/settings/apps/new`
}

export async function manifestCallback(deps: SourceConnectionWorkflowDeps): Promise<Response> {
	const principalId = requireHuman(deps.auth)
	const outcome = await completeManifestCallback(deps, (stateHash) => deps.env.REPOSITORIES.githubConnections.claimCallback(stateHash, principalId))
	return outcome === null ? consoleRedirect() : cleanRedirect(outcome)
}

/**
 * GitHub's return from App creation to a browser that came through a handoff link. The one-use state proves the
 * browser posted this attempt's manifest; the attempt must have a minted link. Success sends the owner on to the
 * installation, as for the administrator; anything else tells the owner to hand back to the administrator.
 */
export async function handedOffCallback(deps: SourceConnectionRequestDeps): Promise<Response> {
	const outcome = await completeManifestCallback(deps, (stateHash) => deps.env.REPOSITORIES.githubConnections.claimHandedOffCallback(stateHash))
	return outcome === null ? handoffResult('setup-incomplete', deps.randomBytes) : cleanRedirect(outcome)
}

/** Claim, exchange and persist; the installation URL to send the browser to, or `null` when the console has to take over. */
async function completeManifestCallback(
	deps: SourceConnectionRequestDeps,
	claim: (stateHash: string) => Promise<GitHubSetupAttempt | null>,
): Promise<string | null> {
	const origin = requireControlOrigin(deps.env)
	const url = new URL(deps.request.url)
	if (url.search.length > MAX_CALLBACK_QUERY_LENGTH) throw new SourceConnectionWorkflowError(400)
	if ([...url.searchParams.keys()].some((key) => key !== 'state' && key !== 'code')) throw new SourceConnectionWorkflowError(400)
	const state = exactQueryValue(deps.request, 'state', 256)
	const code = exactQueryValue(deps.request, 'code', 256)
	if (state === null || code === null) throw new SourceConnectionWorkflowError(400)
	const stateHash = await sha256(state)
	const claimed = await claim(stateHash)
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
	} catch (error) {
		const disposition = await settleCallbackFailure(deps, claimed, error)
		throwIfAborted(deps.request.signal)
		if (disposition === 'failed') throw callbackFailed(claimed, error)
		return null
	}
	// Straight on to the installation: GitHub returns the installer to the App's setup URL, where Control verifies it.
	const configured = await deps.env.REPOSITORIES.githubConnections.getAttempt(claimed.id).catch(() => null)
	if (configured === null || configured.status !== 'active' || configured.phase !== 'installation_required' || configured.appHtmlUrl === null) {
		return null
	}
	return installationUrl(configured.appHtmlUrl)
}

/** The form's one `token` field, or `null` for any other body. */
async function postedToken(request: Request): Promise<string | null> {
	const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
	if (type !== 'application/x-www-form-urlencoded') return null
	const body = await readBoundedText(request, MAX_CALLBACK_QUERY_LENGTH)
	if (body === null) return null
	const form = new URLSearchParams(body)
	if ([...form.keys()].some((key) => key !== 'token')) return null
	const values = form.getAll('token')
	const value = values.length === 1 ? values[0] : undefined
	return value === undefined || value === '' || value.length > 256 ? null : value
}

function exactQueryValue(request: Request, key: string, maxLength: number): string | null {
	const values = new URL(request.url).searchParams.getAll(key)
	if (values.length !== 1) return null
	const value = values[0]
	return value === undefined || value === '' || value.length > maxLength ? null : value
}

function canonicalRepositories(
	appOwner: string,
	repositories: readonly { readonly owner: string; readonly name: string }[],
): { readonly owner: string; readonly name: string }[] {
	const owner = appOwner.toLowerCase()
	const unique = new Map<string, { readonly owner: string; readonly name: string }>()
	for (const repository of repositories) {
		if (repository.owner.toLowerCase() !== owner) throw new SourceConnectionWorkflowError(400, 'repositories must belong to the App owner')
		if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(repository.owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repository.name)) {
			throw new SourceConnectionWorkflowError(400)
		}
		const normalized = { owner, name: repository.name.toLowerCase() }
		unique.set(`${normalized.owner}/${normalized.name}`, normalized)
	}
	return [...unique.values()].sort((left, right) => `${left.owner}/${left.name}`.localeCompare(`${right.owner}/${right.name}`))
}

/** A manifest posted through a handoff link names the handoff routes, which take no console session. */
function buildManifest(owner: string, appName: string, origin: string, connectionId: string, mode: ManifestHandoffMode) {
	try {
		return buildGitHubAppManifest({
			organization: owner,
			appName,
			homepageUrl: origin,
			webhookUrl: `${origin}/webhooks/github/${encodeURIComponent(connectionId)}`,
			redirectUrl: `${origin}${mode === 'handoff' ? HANDOFF_CALLBACK_PATH : CALLBACK_PATH}`,
			setupUrl: `${origin}${mode === 'handoff' ? HANDOFF_SETUP_PATH : SETUP_PATH}/${encodeURIComponent(connectionId)}`,
			public: false,
		})
	} catch {
		throw new SourceConnectionWorkflowError(400)
	}
}

async function settleCallbackFailure(
	deps: SourceConnectionRequestDeps,
	claimed: GitHubSetupAttempt,
	error: unknown,
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
			const settled = await settleFailedStep(deps, current, error).catch(() => null)
			if (settled !== null) return settled.status === 'failed' ? 'failed' : 'repair_required'
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

/**
 * The browser's answer when the callback failed the attempt. An App on another owner than the setup asked for is the
 * operator's to fix, so the answer says how; anything else names no cause.
 */
function callbackFailed(claimed: GitHubSetupAttempt, error: unknown): SourceConnectionWorkflowError {
	return appOwnerFailed(claimed.desiredOwner, error) ?? new SourceConnectionWorkflowError(503)
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
