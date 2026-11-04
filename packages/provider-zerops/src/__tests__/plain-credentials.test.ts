import { describe, expect, test } from 'bun:test'
import { compileFabrikaManifest, createZeropsArtifactSourceDescriptor, parseFabrikaManifest } from '../manifest'
import type { ZeropsAppConfig, ZeropsServiceSpec } from '../types'

const SERVICES: ZeropsServiceSpec[] = [{ hostname: 'notes', type: 'alpine/bun@1.3' }]

const app = (extra: Partial<ZeropsAppConfig['target']> = {}): ZeropsAppConfig => ({
	id: 'notes',
	pipeline: { secrets: ['POSTMARK_TOKEN'], vars: [] },
	target: { platform: 'zerops', services: () => SERVICES, ...extra },
})

/** A `zerops.yaml` whose one setup's run section has these variables. */
const withRunVariables = (variables: Readonly<Record<string, string>>): string =>
	[
		'zerops:',
		'  - setup: notes',
		'    run:',
		'      envVariables:',
		...Object.entries(variables).map(([name, value]) => `        ${name}: ${JSON.stringify(value)}`),
		'',
	]
		.join('\n')

const build = async (config: ZeropsAppConfig, descriptor = 'zerops: [{setup: notes}]\n') =>
	compileFabrikaManifest(config, 'prod', await createZeropsArtifactSourceDescriptor(descriptor))

const refusal = async (config: ZeropsAppConfig, descriptor?: string): Promise<string> => {
	try {
		await build(config, descriptor)
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
	throw new Error('expected the build to be refused')
}

describe('fabrika app build refuses a credential in plain configuration', () => {
	test('a variable, by name, naming where it belongs and never the value', async () => {
		const message = await refusal(app(), withRunVariables({ POSTMARK_TOKEN: 'pm-1234' }))
		expect(message).toContain('zerops.yaml.zerops[0].run.envVariables.POSTMARK_TOKEN: its name contains `TOKEN`')
		expect(message).toContain('pipeline.secrets')
		expect(message).toContain('fabrika control apps secrets put')
		expect(message).toContain('target.notSecret')
		expect(message).not.toContain('pm-1234')
	})

	test('a zerops.yaml variable by value, and a routing header', async () => {
		const descriptor = [
			'zerops:',
			'  - setup: notes',
			'    run:',
			'      envVariables:',
			'        UPSTREAM: "https://app:hunter2@api.example.com"',
			'      routing:',
			'        headers:',
			'          - for: "/*"',
			'            values:',
			'              X-Api-Key: "abc"',
			'',
		].join('\n')
		const message = await refusal(app(), descriptor)
		expect(message).toContain('zerops.yaml.zerops[0].run.envVariables.UPSTREAM: its URL carries a password')
		expect(message).toContain('zerops.yaml.zerops[0].run.routing.headers[0].values.X-Api-Key: its name contains `KEY`')
		expect(message).toContain('sent to every visitor')
		expect(message).not.toContain('hunter2')
	})

	test('a reference, a setting that describes a credential and a plain setting all build', async () => {
		const variables = { LOG_LEVEL: 'info', DATABASE_PASSWORD: '${notes_password}', SESSION_TOKEN_TTL: '3600' }
		const manifest = await build(app(), withRunVariables(variables))
		expect(parseFabrikaManifest(manifest).target.sourceDescriptor.contents).toBe(withRunVariables(variables))
	})

	test('target.notSecret lets a named value through, and stays out of the manifest', async () => {
		const descriptor = withRunVariables({ CSRF_TOKEN_COOKIE: '__Host-csrf' })
		await refusal(app(), descriptor)
		const manifest = await build(app({ notSecret: ['CSRF_TOKEN_COOKIE'] }), descriptor)
		expect(JSON.stringify(manifest)).not.toContain('notSecret')
	})

	test('target.notSecret names a header in any case, as HTTP does', async () => {
		const descriptor = [
			'zerops:',
			'  - setup: notes',
			'    run:',
			'      routing:',
			'        headers:',
			'          - for: "/*"',
			'            values:',
			'              X-Api-Key: "public-demo"',
			'',
		].join('\n')
		await refusal(app(), descriptor)
		await build(app({ notSecret: ['x-api-key'] }), descriptor)
	})
})
