import { expect, test } from 'bun:test'
import { parseEnvironments, parseRun, PlatformRemote } from '../src/platform-remote'
import { PlatformError } from '../src/platform-storage'

test('remote projections keep exact identities, finite recursive JSON and forward-compatible fields', () => {
	const envelope = { provider: 'zerops', version: 0, payload: { list: [null, true, 'x', 1.5] } }
	const environment = {
		appId: ' app ',
		env: 'dev',
		domain: null,
		publicOrigin: null,
		triggerRef: '',
		authoring: false,
		namespaceId: null,
		provider: 'zerops',
		target: envelope,
		artifact: envelope,
		createdAt: 0,
	}
	expect(() => parseEnvironments({ items: [environment] })).toThrow(PlatformError)
	expect(parseEnvironments({ items: [{ ...environment, triggerRef: null, ignored: true }], cursor: 'next' }))
		.toEqual([{ ...environment, triggerRef: null }])
	expect(() => parseEnvironments({ items: [{ ...environment, triggerRef: null, target: { ...envelope, payload: { secret: Infinity } } }] }))
		.toThrow('Invalid stored or upstream data')
	const run: ReturnType<typeof parseRun> = { id: 'run', appId: 'app', env: 'dev', ref: 'sha', commitSha: null, status: 'running' }
	expect(parseRun({ ...run, extra: 'ignored' })).toEqual(run)
	expect(() => parseRun({ ...run, status: 'cancelled' })).toThrow('Invalid deploy run status')
	expect(() => parseRun({ ...run, commitSha: undefined })).toThrow('Invalid stored or upstream data')
})

test('discovery keeps Builder-specific origin policy and explicit unsupported-provider diagnostics', async () => {
	const remote = (data: unknown) => new PlatformRemote(async () => Response.json(data), new AbortController().signal)
	const discovery = { version: 1, controlOrigin: 'http://localhost:1234/', iamIssuer: 'https://iam.example.test/', provider: 'zerops' }
	expect(await remote(discovery).discover('http://localhost:1234')).toEqual({
		controlOrigin: 'http://localhost:1234',
		iamIssuer: 'https://iam.example.test',
	})
	await expect(remote({ ...discovery, provider: 'future' }).discover('http://localhost:1234')).rejects.toThrow('Unsupported provider')
	await expect(remote({ ...discovery, controlOrigin: 'http://127.1:1234' }).discover('http://localhost:1234')).rejects.toThrow()
	await expect(remote({ ...discovery, secret: 'credential' }).discover('http://localhost:1234')).rejects.toThrow(
		'Unsupported builder discovery response',
	)
})
