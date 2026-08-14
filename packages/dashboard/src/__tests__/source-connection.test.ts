import { describe, expect, jest, test } from 'bun:test'
import type { GitHubSourceConnectionStatusDto } from '../lib/api'
import {
	MAX_SOURCE_REPOSITORIES,
	parseSourceRepositories,
	scheduleSourceConnectionPoll,
	sourceChain,
	sourceManifestContinuePath,
} from '../lib/source-connection'

describe('source connection presentation', () => {
	test('accepts only unique repositories owned by the selected organization', () => {
		expect(parseSourceRepositories('Acme/API\nacme/web', ' ACME ')).toEqual([
			{ owner: 'acme', name: 'api' },
			{ owner: 'acme', name: 'web' },
		])
		for (const value of ['other/api', 'acme/api/extra', 'acme/..', 'acme/api\nacme/API']) {
			expect(() => parseSourceRepositories(value, 'acme')).toThrow()
		}
		const tooMany = Array.from({ length: MAX_SOURCE_REPOSITORIES + 1 }, (_, index) => `acme/repo-${index}`).join('\n')
		expect(() => parseSourceRepositories(tooMany, 'acme')).toThrow(`Enter no more than ${MAX_SOURCE_REPOSITORIES} repositories.`)
	})

	test('schedules one refresh per pending render and stops after a terminal response', () => {
		jest.useFakeTimers()
		try {
			const pending = (phase: 'starting' | 'awaiting-manifest-callback'): GitHubSourceConnectionStatusDto => ({
				provider: 'zerops',
				kind: 'github-app',
				state: 'setup-pending',
				connectionId: 'connection-1',
				phase,
			})
			const terminal: GitHubSourceConnectionStatusDto = { provider: 'zerops', kind: 'github-app', state: 'adoption-required' }
			const responses: readonly GitHubSourceConnectionStatusDto[] = [
				pending('starting'),
				pending('awaiting-manifest-callback'),
				terminal,
			]
			let responseIndex = 0
			let refreshes = 0
			let cancel = () => undefined
			const schedule = (callback: () => void, delayMs: number) => {
				const timer = setTimeout(callback, delayMs)
				return () => clearTimeout(timer)
			}
			const render = () => {
				cancel()
				cancel = scheduleSourceConnectionPoll(responses[responseIndex] ?? terminal, () => {
					refreshes++
					responseIndex++
					render()
				}, schedule)
			}

			render()
			jest.advanceTimersByTime(6_000)
			expect(refreshes).toBe(2)
			cancel()
		} finally {
			jest.useRealTimers()
		}
	})

	test('resumes a lost start response only from the exact server-bound manifest path', () => {
		const pending: GitHubSourceConnectionStatusDto = {
			provider: 'zerops',
			kind: 'github-app',
			state: 'setup-pending',
			connectionId: 'connection-1',
			phase: 'awaiting-manifest-callback',
			continuePath: '/api/source/github/manifest/connection-1',
		}
		expect(sourceManifestContinuePath(pending)).toBe('/api/source/github/manifest/connection-1')
		expect(sourceManifestContinuePath({ ...pending, phase: 'activating' })).toBeNull()
		expect(sourceManifestContinuePath({ ...pending, continuePath: '//evil.example/manifest/connection-1' })).toBeNull()
	})

	test('maps durable backend phases to the three physical connection lamps', () => {
		const pending: GitHubSourceConnectionStatusDto = {
			provider: 'zerops',
			kind: 'github-app',
			state: 'setup-pending',
			connectionId: 'connection-1',
			phase: 'activating',
		}
		expect(sourceChain(pending).map((node) => [node.label, node.lamp])).toEqual([
			['GitHub App', 'ok'],
			['Private source', 'run'],
			['Webhook', 'idle'],
		])
		const unavailable: GitHubSourceConnectionStatusDto = { provider: 'legacy', kind: 'github-app', state: 'unavailable' }
		expect(sourceChain(unavailable).every((node) => node.lamp === 'idle')).toBe(true)
		const adoption: GitHubSourceConnectionStatusDto = { provider: 'zerops', kind: 'github-app', state: 'adoption-required' }
		expect(sourceChain(adoption).map((node) => [node.lamp, node.detail])).toEqual([
			['ok', 'existing credentials'],
			['ok', 'credentials present'],
			['run', 'adoption required'],
		])
	})
})
