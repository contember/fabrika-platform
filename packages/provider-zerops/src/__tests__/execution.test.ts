import { canonicalArtifactJson, type ContractArtifact } from '@fabrika/auth-core'
import type { JsonValue } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import checkManifest from '../../../check/package.json'
import { parseZeropsDescriptor } from '../descriptor'
import { FABRIKA_CHECK_VERSION, PLATFORM_TYPESCRIPT_VERSION, renderLockedExecutionDescriptor, zeropsContractRun } from '../execution'
import {
	compileFabrikaManifest,
	createZeropsArtifactSourceDescriptor,
	type FabrikaManifest,
	lockedExecutionOf,
	zeropsArtifactCodec,
	type ZeropsArtifactSourceDescriptor,
} from '../manifest'
import type { ZeropsAppConfig, ZeropsServiceSpec } from '../types'
import { LOCKED_REPOSITORIES } from './fixtures/locked-repositories'

const SPA_DESCRIPTOR = 'zerops:\n  - setup: notesapi\n    build:\n      buildCommands: ["bun run build:spa"]\n'

const API: ZeropsServiceSpec = { hostname: 'notesapi', type: 'alpine/bun@1.3' }
const DATABASE: ZeropsServiceSpec = { hostname: 'notesdb', type: 'postgresql:single@18' }

const contractApp = (target: Partial<ZeropsAppConfig['target']> = {}, id = 'notes'): ZeropsAppConfig => ({
	id,
	target: {
		platform: 'zerops',
		services: () => [DATABASE, API],
		deployService: 'notesapi',
		contract: notesArtifact,
		...target,
	},
})

const compile = async (config: ZeropsAppConfig, contents = SPA_DESCRIPTOR): Promise<FabrikaManifest> =>
	compileFabrikaManifest(config, 'prod', await createZeropsArtifactSourceDescriptor(contents))

type Mapping = { readonly [key: string]: JsonValue }

const mapping = (value: JsonValue | undefined): Mapping => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected a mapping')
	return value
}

const render = (manifest: FabrikaManifest, release: string | null = 'r1'): Mapping => {
	const execution = lockedExecutionOf(manifest)
	if (execution === null) throw new Error('expected a contract application')
	const rendered = renderLockedExecutionDescriptor(manifest.target.sourceDescriptor.contents, manifest.target.zeropsSetup, release, execution)
	const setups = parseZeropsDescriptor(rendered.contents).document['zerops']
	if (!Array.isArray(setups) || setups.length !== 1) throw new Error('expected one setup')
	return mapping(setups[0])
}

const withTarget = (payload: JsonValue, patch: Mapping): JsonValue => {
	const manifest = mapping(payload)
	return { ...manifest, target: { ...mapping(manifest['target']), ...patch } }
}

const DIGEST = `sha256:${new Bun.CryptoHasher('sha256').update(canonicalArtifactJson(notesArtifact)).digest('hex')}`

describe('the generated execution descriptor of a contract application', () => {
	test('carries the run facts of the contract in the artifact', async () => {
		const manifest = await compile(contractApp({ runtimePackages: ['vips'] }))
		expect(manifest.target.contract).toEqual({ digest: DIGEST, readinessPath: '/healthz', jobs: [{ name: 'purgeDeleted', schedule: '0 3 * * *' }] })
		expect(zeropsArtifactCodec.decode(zeropsArtifactCodec.encode(manifest))).toEqual(manifest)
	})

	test('keeps the SPA commands first and generates the rest of the build, the deploy gate and the run section', async () => {
		const setup = render(await compile(contractApp({ runtimePackages: ['vips', 'ffmpeg'] })))
		expect(setup).toEqual({
			setup: 'notesapi',
			build: {
				base: ['alpine/bun@1.3'],
				buildCommands: [
					'bun run build:spa',
					'bun install --frozen-lockfile --ignore-scripts',
					`cd /tmp && bun x --bun -p @fabrika/check@${FABRIKA_CHECK_VERSION} fabrika-check /build/source`,
					`bun -e "await import('@fabrika/app/build').then((build) => build.writeGeneratedEntry('.', 'bun'))"`,
					expect.stringMatching(/^printf '%s\\n' '\{"compilerOptions":.*' > fabrika\/tsconfig\.platform\.json$/),
					`cd /tmp && bun x --bun -p typescript@${PLATFORM_TYPESCRIPT_VERSION} tsc -p /build/source/fabrika/tsconfig.platform.json`,
					'bun test --pass-with-no-tests',
					"printf '%s\\n' '#!/bin/sh' 'set -eu' 'cd /var/www' 'FABRIKA_APP_ID=notes exec ./node_modules/.bin/fabrika db migrate' > fabrika/migrate.generated.sh",
					"printf '%s\\n' '#!/bin/sh' 'set -eu' 'cd /var/www' 'sh /var/www/fabrika/migrate.generated.sh' 'exec bun fabrika/entry.generated.ts' > fabrika/start.generated.sh",
				],
				deployFiles: ['./'],
				cache: ['node_modules'],
			},
			deploy: { readinessCheck: { httpGet: { port: 3000, path: '/healthz' }, retryPeriod: '10s', failureTimeout: '180s' } },
			run: {
				base: 'alpine/bun@1.3',
				prepareCommands: ['sudo apk add --no-cache ffmpeg vips'],
				initCommands: ['sh /var/www/fabrika/migrate.generated.sh'],
				start: 'sh /var/www/fabrika/start.generated.sh',
				ports: [{ port: 3000, httpSupport: true }],
				healthCheck: {
					httpGet: { port: 3000, path: '/healthz' },
					execPeriod: '10s',
					disconnectTimeout: '30s',
					recoveryTimeout: '10s',
					failureTimeout: '120s',
				},
				crontab: [{ timing: '0 3 * * *', command: './node_modules/.bin/fabrika job run purgeDeleted', allContainers: false }],
				envVariables: {
					PORT: '3000',
					FABRIKA_CONTRACT_DIGEST: DIGEST,
					FABRIKA_RELEASE: 'r1',
					FABRIKA_APP_DATABASE_URL: '${notesdb_connectionTlsString}/${notesdb_dbName}?sslmode=require',
				},
			},
		})
	})

	test('the server starts only after the migration it expects ran, so a failed migration fails the readiness check', async () => {
		const commands = mapping(render(await compile(contractApp()))['build'])['buildCommands']
		const start = Array.isArray(commands) ? commands.find((command) => String(command).includes('start.generated.sh')) : undefined
		expect(String(start)).toMatch(/'set -eu' 'cd \/var\/www' 'sh \/var\/www\/fabrika\/migrate\.generated\.sh' 'exec bun /)
	})

	test('an application without a database runs no migration', async () => {
		const setup = render(await compile(contractApp({ services: () => [API] })), null)
		expect(setup['run']).toMatchObject({
			start: 'sh /var/www/fabrika/start.generated.sh',
			envVariables: { PORT: '3000', FABRIKA_CONTRACT_DIGEST: DIGEST },
		})
		expect(JSON.stringify(setup)).not.toContain('migrate')
		expect(JSON.stringify(setup)).not.toContain('FABRIKA_RELEASE')
	})

	test("the namespace's shared PostgreSQL is the database of an application that declares none", async () => {
		const manifest = await compile(contractApp({
			services: () => [API],
			namespaceResources: [{
				resourceKey: 'service:postgres',
				hostname: 'postgres',
				connectionString: '${postgres_connectionTlsString}/${postgres_dbName}?sslmode=require',
			}],
		}))
		expect(lockedExecutionOf(manifest)?.databaseUrl).toBe('${postgres_connectionTlsString}/${postgres_dbName}?sslmode=require')
	})

	test('only the selected setup reaches the platform, and the source descriptor stays the identity', async () => {
		const contents = `${SPA_DESCRIPTOR}  - setup: other\n    run:\n      start: bun other.ts\n`
		const manifest = await compile(contractApp({ zeropsSetup: 'notesapi' }), contents)
		const execution = lockedExecutionOf(manifest)
		if (execution === null) throw new Error('expected a contract application')
		const rendered = renderLockedExecutionDescriptor(contents, 'notesapi', null, execution)
		expect(parseZeropsDescriptor(rendered.contents).setups).toEqual(['notesapi'])
		expect(manifest.target.sourceDescriptor.contents).toBe(contents)
	})

	test('pins the checker to the version released with this provider', () => {
		expect(FABRIKA_CHECK_VERSION).toBe(checkManifest.version)
	})

	test('an application without a contract keeps its own run section', async () => {
		const manifest = await compile(
			{ id: 'legacy', target: { platform: 'zerops', services: () => [API] } },
			`${SPA_DESCRIPTOR}    run:\n      start: bun x.ts\n`,
		)
		expect(lockedExecutionOf(manifest)).toBeNull()
	})
})

describe('a contract application is refused at compile time', () => {
	for (const repository of LOCKED_REPOSITORIES) {
		test(`with ${repository.name}`, async () => {
			const descriptor = await createZeropsArtifactSourceDescriptor(repository.zeropsYaml)
			expect(() => compileFabrikaManifest(contractApp(), 'prod', descriptor)).toThrow(
				`zerops.yaml setup \`notesapi\` sets \`${repository.refused}\``,
			)
		})
	}

	test('and on every decode of a stored artifact', async () => {
		const manifest = await compile(contractApp())
		const tampered: ZeropsArtifactSourceDescriptor = await createZeropsArtifactSourceDescriptor(
			`${SPA_DESCRIPTOR}    run:\n      start: bun src/server.ts\n`,
		)
		const payload = zeropsArtifactCodec.encode({ ...manifest, target: { ...manifest.target, sourceDescriptor: tampered } })
		expect(() => zeropsArtifactCodec.decode(payload)).toThrow('sets `run.start`')
	})

	test('without a health endpoint for the readiness check', () => {
		const withoutHealth: ContractArtifact = { ...notesArtifact, endpoints: notesArtifact.endpoints.filter((row) => row.kind !== 'health') }
		expect(() => zeropsContractRun(withoutHealth)).toThrow("c.health('/healthz')")
	})

	test('for a contract of another application', async () => {
		await expect(compile(contractApp({}, 'other'))).rejects.toThrow('the contract declares app `notes`, but the config is app `other`')
	})

	test('with two databases', async () => {
		await expect(compile(contractApp({ services: () => [DATABASE, { hostname: 'otherdb', type: 'postgresql:single@18' }, API] }))).rejects
			.toThrow('more than one')
	})

	test('with an application id a generated script cannot name', async () => {
		const artifact: ContractArtifact = { ...notesArtifact, app: 'Notes_App' }
		await expect(compile(contractApp({ contract: artifact }, 'Notes_App'))).rejects.toThrow('[a-z0-9][a-z0-9-]*')
	})

	test('with a runtime package outside the list, or on an application without a contract', async () => {
		const encoded = zeropsArtifactCodec.encode(await compile(contractApp()))
		expect(() => zeropsArtifactCodec.decode(withTarget(encoded, { runtimePackages: ['curl'] }))).toThrow('invalid fabrika manifest runtime packages')
		const withoutContract = compile({ id: 'legacy', target: { platform: 'zerops', services: () => [API], runtimePackages: ['vips'] } })
		await expect(withoutContract).rejects.toThrow('contract application only')
	})
})
