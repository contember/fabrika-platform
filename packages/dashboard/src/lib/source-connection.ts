import type { GitHubSourceConnectionStatusDto, GitHubSourceRepositoryDto } from './api'

const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/
const REPOSITORY = /^(?!\.\.?$)[a-z0-9._-]{1,100}$/

export const MAX_SOURCE_ORGANIZATION_LENGTH = 39
export const MAX_SOURCE_APP_NAME_LENGTH = 100
export const MAX_SOURCE_REPOSITORIES = 100
export const MAX_SOURCE_REPOSITORIES_TEXT_LENGTH = 14_099

export type SourcePollScheduler = (callback: () => void, delayMs: number) => () => void

export interface SourceChainNode {
	readonly label: string
	readonly detail: string
	readonly lamp: 'ok' | 'run' | 'stop' | 'idle'
}

export function parseSourceRepositories(value: string, organization: string): readonly GitHubSourceRepositoryDto[] {
	if (value.length > MAX_SOURCE_REPOSITORIES_TEXT_LENGTH) throw new Error(`Enter no more than ${MAX_SOURCE_REPOSITORIES} repositories.`)
	const owner = organization.trim().toLowerCase()
	if (!OWNER.test(owner)) throw new Error('Enter a valid GitHub organization.')
	const repositories: GitHubSourceRepositoryDto[] = []
	const seen = new Set<string>()
	for (const line of value.split('\n')) {
		const coordinate = line.trim().toLowerCase()
		if (coordinate === '') continue
		const parts = coordinate.split('/')
		if (parts.length !== 2 || parts[0] !== owner || !REPOSITORY.test(parts[1] ?? '')) {
			throw new Error(`Every repository must use the ${owner}/repository form and belong to the same organization.`)
		}
		if (seen.has(coordinate)) throw new Error(`Repository ${coordinate} is listed more than once.`)
		if (repositories.length >= MAX_SOURCE_REPOSITORIES) throw new Error(`Enter no more than ${MAX_SOURCE_REPOSITORIES} repositories.`)
		seen.add(coordinate)
		repositories.push({ owner, name: parts[1] ?? '' })
	}
	return repositories
}

export function scheduleSourceConnectionPoll(
	status: GitHubSourceConnectionStatusDto,
	invalidate: () => void,
	schedule: SourcePollScheduler,
): () => void {
	if (status.state !== 'setup-pending') return () => undefined
	return schedule(invalidate, 2_000)
}

export function sourceManifestContinuePath(status: GitHubSourceConnectionStatusDto): string | null {
	if (status.state !== 'setup-pending' || status.phase !== 'awaiting-manifest-callback' || status.continuePath === undefined) return null
	const expected = `/api/source/github/manifest/${encodeURIComponent(status.connectionId)}`
	return status.continuePath === expected ? status.continuePath : null
}

export function sourceChain(status: GitHubSourceConnectionStatusDto): readonly SourceChainNode[] {
	if (status.state === 'connected') {
		return [
			{ label: 'GitHub App', detail: status.app.slug, lamp: 'ok' },
			{ label: 'Private source', detail: 'credentials active', lamp: 'ok' },
			{ label: 'Webhook', detail: 'delivery verified', lamp: 'ok' },
		]
	}
	if (status.state === 'installation-required') {
		return [
			{ label: 'GitHub App', detail: status.app.slug, lamp: 'ok' },
			{ label: 'Private source', detail: 'credentials active', lamp: 'ok' },
			{ label: 'Webhook', detail: 'awaiting repository grant', lamp: 'run' },
		]
	}
	if (status.state === 'setup-pending') {
		const appReady = status.phase === 'persisting' || status.phase === 'activating'
		return [
			{ label: 'GitHub App', detail: appReady ? 'manifest converted' : 'manifest handoff', lamp: appReady ? 'ok' : 'run' },
			{
				label: 'Private source',
				detail: status.phase === 'activating' ? 'activating' : 'waiting',
				lamp: status.phase === 'activating' ? 'run' : 'idle',
			},
			{ label: 'Webhook', detail: 'waiting', lamp: 'idle' },
		]
	}
	if (status.state === 'repair-required') {
		return [
			{ label: 'GitHub App', detail: status.app?.slug ?? 'verification required', lamp: status.app === undefined ? 'stop' : 'ok' },
			{ label: 'Private source', detail: 'repair required', lamp: 'stop' },
			{ label: 'Webhook', detail: 'not verified', lamp: 'stop' },
		]
	}
	if (status.state === 'adoption-required') {
		return [
			{ label: 'GitHub App', detail: 'existing credentials', lamp: 'ok' },
			{ label: 'Private source', detail: 'credentials present', lamp: 'ok' },
			{ label: 'Webhook', detail: 'adoption required', lamp: 'run' },
		]
	}
	const detail = status.state === 'unavailable' ? 'unsupported setup' : 'not configured'
	return [
		{ label: 'GitHub App', detail, lamp: 'idle' },
		{ label: 'Private source', detail: 'not connected', lamp: 'idle' },
		{ label: 'Webhook', detail: 'not connected', lamp: 'idle' },
	]
}
