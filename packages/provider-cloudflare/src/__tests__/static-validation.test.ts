import { expect, test } from 'bun:test'
import { cloudflareArtifactCodec, cloudflareTargetCodec } from '../codec'
import { cloudflareRunnerJobSchema, cloudflareStoredTargetCodec, isCloudflareRunnerJob } from '../control'
import { parseAppSchema } from '../schema'

const job = {
	runId: '0198c4a2-7b31-7e44-9a55-0b1c2d3e4f50',
	repoUrl: 'https://github.com/acme/app.git',
	ref: 'a'.repeat(40),
	env: 'prod',
	credentials: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'private-token' },
}

test('runner job preserves wire extensions, optional undefined and own environment names', () => {
	const secrets = { ['__proto__']: 'secret', EMPTY: '' }
	const parsed = cloudflareRunnerJobSchema.parse({ ...job, runnerKey: undefined, secrets, extension: 'future' })
	expect(parsed).toEqual({ ...job, runnerKey: undefined, secrets, extension: 'future' })
	expect(Object.hasOwn(parsed, 'runnerKey')).toBe(true)
	expect(Object.hasOwn(parsed, 'domain')).toBe(false)
	expect(Object.hasOwn(parsed.secrets ?? {}, '__proto__')).toBe(true)
	expect(parsed.credentials).not.toBe(job.credentials)
})

for (
	const field of [
		'workerDir',
		'configPath',
		'stateNamespace',
		'domain',
		'returnOrigins',
		'dryRun',
		'runnerKey',
		'secrets',
		'vars',
		'managedEnvironment',
		'artifactUpload',
	]
) {
	test(`runner job rejects null ${field} but accepts absent and undefined`, () => {
		expect(isCloudflareRunnerJob({ ...job, [field]: null })).toBe(false)
		expect(isCloudflareRunnerJob({ ...job, [field]: undefined })).toBe(true)
	})
}

test('runner rejects extra credential names, tuple environment records and noncanonical deployment refs', () => {
	expect(isCloudflareRunnerJob({ ...job, credentials: { ...job.credentials, IAM_KEY: 'private-key' } })).toBe(false)
	expect(isCloudflareRunnerJob({ ...job, secrets: [['KEY', 'value']] })).toBe(false)
	for (const ref of ['main', 'A'.repeat(40), `${'a'.repeat(40)}\n`, 'a'.repeat(39)]) {
		expect(isCloudflareRunnerJob({ ...job, ref })).toBe(false)
	}
	expect(cloudflareRunnerJobSchema.parse({ ...job, ref: 'main', dryRun: true }).ref).toBe('main')
})

test('codecs strip extensions and omit undefined state namespace without normalizing values', () => {
	expect(cloudflareStoredTargetCodec.decode({ ignored: 'value' })).toEqual({})
	expect(cloudflareStoredTargetCodec.encode({ stateNamespace: undefined })).toEqual({})
	expect(cloudflareTargetCodec.decode({ accountId: ' account ', apiToken: 'token', ignored: 'value' }))
		.toEqual({ accountId: ' account ', apiToken: 'token' })
	expect(cloudflareArtifactCodec.decode({ configPath: '../absolute-config-compatible.ts', ignored: true }))
		.toEqual({ configPath: '../absolute-config-compatible.ts' })
	for (const stateNamespace of [null, '', 1]) {
		expect(() => cloudflareStoredTargetCodec.decode({ stateNamespace })).toThrow()
	}
})

test('IAM vocabulary uses own fields, strips extensions, and omits explicit undefined labels', () => {
	const inherited: unknown = Object.create({ type: 'inherited' })
	expect(parseAppSchema({ scopes: [inherited], actions: [], roles: {} }).ok).toBe(false)
	const result = parseAppSchema({
		scopes: [{ type: 'team', label: undefined, extra: 1 }],
		actions: [{ action: 'read', description: undefined }],
		roles: { reader: { name: 'Reader', description: undefined, permissions: ['read'], extra: 1 } },
	})
	expect(result).toEqual({
		ok: true,
		schema: {
			scopes: [{ type: 'team' }],
			actions: [{ action: 'read' }],
			roles: { reader: { name: 'Reader', permissions: ['read'] } },
		},
	})
	expect(parseAppSchema({ scopes: [{ type: 'team', label: null }], actions: [], roles: {} }).ok).toBe(false)
})
