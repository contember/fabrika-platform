import { canonicalArtifactJson, type ContractArtifact, contractDigest } from '@fabrika/auth-core'
import type { JsonValue } from '@fabrika/provider-contract'
import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import checkManifest from '../../../check/package.json'
import { useSharedPostgres } from '../authoring'
import { parseZeropsDescriptor } from '../descriptor'
import {
	FABRIKA_CHECK_VERSION,
	PLATFORM_TYPESCRIPT_VERSION,
	renderLockedExecutionDescriptor,
	zeropsAssetRoots,
	zeropsContractRun,
} from '../execution'
import {
	compileFabrikaManifest,
	createZeropsArtifactSourceDescriptor,
	type FabrikaManifest,
	lockedExecutionOf,
	parseFabrikaManifest,
	zeropsArtifactCodec,
	type ZeropsArtifactSourceDescriptor,
} from '../manifest'
import type { ZeropsAppConfig, ZeropsServiceSpec } from '../types'
import { LOCKED_REPOSITORIES } from './fixtures/locked-repositories'

const SPA_DESCRIPTOR = 'zerops:\n  - setup: notesapi\n    build:\n      buildCommands: ["bun run build:spa"]\n'

const API: ZeropsServiceSpec = { hostname: 'notesapi', type: 'alpine/bun@1.3' }
const DATABASE: ZeropsServiceSpec = { hostname: 'notesdb', type: 'postgresql:single@18' }
const BUCKET: ZeropsServiceSpec = { hostname: 'notesfiles', type: 'object-storage', objectStorageSize: 1 }
// The service's superuser on the direct port: `db` cannot create roles, and pgBouncer on `portTls` refuses the roles it would.
const NOTESDB_PROVISIONING_URL =
	'postgresql://${notesdb_superUser}:${notesdb_superUserPassword}@${notesdb_hostname}:${notesdb_port}/${notesdb_dbName}?sslmode=disable'

const contractApp = (target: Partial<ZeropsAppConfig['target']> = {}, id = 'notes'): ZeropsAppConfig => ({
	id,
	target: {
		platform: 'zerops',
		services: () => [DATABASE, API],
		deployService: 'notesapi',
		contract: notesArtifact,
		proxy: { upstream: 'notesapi:3000', ...contractProxyTable(target.contract ?? notesArtifact) },
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
		expect(manifest.target.contract).toEqual({
			digest: DIGEST,
			readinessPath: '/healthz',
			jobs: [{ name: 'purgeDeleted', schedule: '0 3 * * *' }],
			files: true,
		})
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
					'bun test --isolate --pass-with-no-tests',
					'rm -rf node_modules && bun install --frozen-lockfile --ignore-scripts',
					`bun -e "await import('@fabrika/app/build').then((build) => build.writeGeneratedEntry('.', 'bun'))"`,
					`cd /tmp && bun x --bun -p @fabrika/check@${FABRIKA_CHECK_VERSION} fabrika-check /build/source`,
					expect.stringMatching(/^printf '%s\\n' '\{"compilerOptions":.*' > fabrika\/tsconfig\.platform\.json$/),
					`cd /tmp && bun x --bun -p typescript@${PLATFORM_TYPESCRIPT_VERSION} tsc -p /build/source/fabrika/tsconfig.platform.json`,
					"printf '%s\\n' '#!/bin/sh' 'set -eu' 'cd /var/www' 'FABRIKA_APP_ID=notes exec ./node_modules/.bin/fabrika db migrate' > fabrika/migrate.generated.sh",
					"printf '%s\\n' '#!/bin/sh' 'set -eu' 'cd /var/www' 'FABRIKA_APP_ID=notes ./node_modules/.bin/fabrika db codegen --verify' 'FABRIKA_APP_ID=notes exec ./node_modules/.bin/fabrika db test-isolation' > fabrika/verify.generated.sh",
					"printf '%s\\n' '#!/bin/sh' 'set -eu' 'cd /var/www' 'exec bun --max-http-header-size=65536 fabrika/entry.generated.ts' > fabrika/start.generated.sh",
				],
				deployFiles: ['./'],
				cache: ['node_modules'],
			},
			deploy: { readinessCheck: { httpGet: { port: 3000, path: '/healthz' }, retryPeriod: '10s', failureTimeout: '180s' } },
			run: {
				base: 'alpine/bun@1.3',
				prepareCommands: ['sudo apk add --no-cache ffmpeg vips'],
				initCommands: ['sh /var/www/fabrika/migrate.generated.sh', 'sh /var/www/fabrika/verify.generated.sh'],
				start: 'sh /var/www/fabrika/start.generated.sh',
				ports: [{ port: 3000, httpSupport: true }],
				healthCheck: {
					httpGet: { port: 3000, path: '/healthz' },
					execPeriod: '10s',
					disconnectTimeout: '30s',
					recoveryTimeout: '10s',
					failureTimeout: '120s',
				},
				crontab: [
					{ timing: '0 3 * * *', command: './node_modules/.bin/fabrika job run purgeDeleted', allContainers: false },
					{ timing: '41 * * * *', command: './node_modules/.bin/fabrika job run fabrika-file-sweep', allContainers: false },
				],
				envVariables: {
					PORT: '3000',
					FABRIKA_CONTRACT_DIGEST: DIGEST,
					FABRIKA_RELEASE: 'r1',
					FABRIKA_APP_DATABASE_URL: NOTESDB_PROVISIONING_URL,
				},
			},
		})
	})

	test('the schema check and the isolation tests run after the migrations, before `run.start` opens the readiness window', async () => {
		const setup = render(await compile(contractApp()))
		expect(mapping(setup['run'])['initCommands']).toEqual(['sh /var/www/fabrika/migrate.generated.sh', 'sh /var/www/fabrika/verify.generated.sh'])
		const commands = mapping(setup['build'])['buildCommands']
		const verify = Array.isArray(commands) ? commands.find((command) => String(command).includes('verify.generated.sh')) : undefined
		expect(String(verify)).toMatch(
			/'set -eu' 'cd \/var\/www' 'FABRIKA_APP_ID=notes \S+ db codegen --verify' 'FABRIKA_APP_ID=notes exec \S+ db test-isolation'/,
		)
		const start = Array.isArray(commands) ? commands.find((command) => String(command).includes('start.generated.sh')) : undefined
		expect(String(start)).not.toContain('fabrika db')
	})

	test('the authored tests run before the reinstall, the regenerated entrypoint and every check', async () => {
		const commands = mapping(render(await compile(contractApp()))['build'])['buildCommands']
		if (!Array.isArray(commands)) throw new Error('expected build commands')
		const position = (needle: string): number => commands.findIndex((command) => String(command).includes(needle))
		expect(position('bun test')).toBeLessThan(position('rm -rf node_modules'))
		expect(position('rm -rf node_modules')).toBeLessThan(position('writeGeneratedEntry'))
		expect(position('writeGeneratedEntry')).toBeLessThan(position('fabrika-check'))
		expect(position('fabrika-check')).toBeLessThan(position(' tsc '))
	})

	test('an application without a database runs no migration', async () => {
		const setup = render(await compile(contractApp({ services: () => [API] })), null)
		expect(setup['run']).toMatchObject({
			start: 'sh /var/www/fabrika/start.generated.sh',
			envVariables: { PORT: '3000', FABRIKA_CONTRACT_DIGEST: DIGEST },
		})
		expect(JSON.stringify(setup)).not.toContain('migrate')
		expect(JSON.stringify(setup)).not.toContain('verify.generated.sh')
		expect(JSON.stringify(setup)).not.toContain('FABRIKA_RELEASE')
	})

	test("an application's object storage reaches it as references Zerops resolves, so no credential passes through Fabrika", async () => {
		const run = render(await compile(contractApp({ services: () => [DATABASE, BUCKET, API] })))['run']
		expect(mapping(run)['envVariables']).toEqual({
			PORT: '3000',
			FABRIKA_CONTRACT_DIGEST: DIGEST,
			FABRIKA_RELEASE: 'r1',
			FABRIKA_APP_DATABASE_URL: NOTESDB_PROVISIONING_URL,
			FABRIKA_APP_STORAGE_ENDPOINT: '${notesfiles_apiUrl}',
			FABRIKA_APP_STORAGE_BUCKET: '${notesfiles_bucketName}',
			FABRIKA_APP_STORAGE_ACCESS_KEY_ID: '${notesfiles_accessKeyId}',
			FABRIKA_APP_STORAGE_SECRET_ACCESS_KEY: '${notesfiles_secretAccessKey}',
		})
	})

	test('an application without object storage gets no storage variable', async () => {
		expect(JSON.stringify(render(await compile(contractApp())))).not.toContain('FABRIKA_APP_STORAGE_')
	})

	test("the namespace's shared PostgreSQL is the database of an application that declares none, provisioned by its superuser", async () => {
		const manifest = await compile(contractApp({ services: () => [API], namespaceResources: [useSharedPostgres()] }))
		expect(lockedExecutionOf(manifest)?.databaseUrl).toBe(
			'postgresql://${postgres_superUser}:${postgres_superUserPassword}@${postgres_hostname}:${postgres_port}/${postgres_dbName}?sslmode=disable',
		)
	})

	test('an artifact built with the TLS-port shared binding still decodes, as the direct-port binding', async () => {
		const manifest = await compile(contractApp({ services: () => [API], namespaceResources: [useSharedPostgres()] }))
		const legacy = parseFabrikaManifest(JSON.parse(
			JSON.stringify(manifest).replace(
				'${postgres_connectionString}/${postgres_dbName}?sslmode=disable',
				'${postgres_connectionTlsString}/${postgres_dbName}?sslmode=require',
			),
		))
		expect(legacy.target.namespaceResources).toEqual([useSharedPostgres()])
		expect(lockedExecutionOf(legacy)?.databaseUrl).toBe(lockedExecutionOf(manifest)?.databaseUrl ?? null)
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

describe('the source-map upload of a contract build', () => {
	const destination = {
		url: 'https://errors.test/api/artifacts/source-maps/',
		appId: 'notes',
		environment: 'prod',
		serviceKey: 'default',
		release: `fabrika/notes/prod/default/${'a'.repeat(40)}`,
		runId: 'run-1',
	}
	const renderWith = async (assetRoots: { prefix: string; dir: string }[]): Promise<Mapping> => {
		const manifest = await compile(contractApp())
		const execution = lockedExecutionOf(manifest)
		if (execution === null) throw new Error('expected a contract application')
		const rendered = renderLockedExecutionDescriptor(manifest.target.sourceDescriptor.contents, manifest.target.zeropsSetup, 'r1', {
			...execution,
			sourceMaps: { destination, assetRoots },
		})
		const setups = parseZeropsDescriptor(rendered.contents).document['zerops']
		if (!Array.isArray(setups)) throw new Error('expected setups')
		return mapping(mapping(setups[0])['build'])
	}

	test('the asset roots are every SPA mount and every share link, by prefix', () => {
		expect(zeropsAssetRoots(notesArtifact)).toEqual([{ prefix: '/', dir: 'dist/app' }, { prefix: '/s', dir: 'dist/share' }])
	})

	test('runs last, after every check, and reads its bearer from the service variable', async () => {
		const build = await renderWith(zeropsAssetRoots(notesArtifact))
		const commands = build['buildCommands']
		expect(Array.isArray(commands) ? commands.at(-1) : null).toBe(
			`cd /tmp && bun x --bun -p @fabrika/check@${FABRIKA_CHECK_VERSION} fabrika-source-maps /build/source || true`,
		)
		const variables = mapping(build['envVariables'])
		expect(variables['FABRIKA_SOURCE_MAP_UPLOAD_KEY']).toBe('${RUNTIME_FABRIKA_SOURCE_MAP_UPLOAD_KEY}')
		expect(JSON.parse(String(variables['FABRIKA_SOURCE_MAP_UPLOAD']))).toEqual({ destination, assetRoots: zeropsAssetRoots(notesArtifact) })
	})

	test('an SPA directory that Zerops would resolve as a reference is refused', async () => {
		await expect(renderWith([{ prefix: '/', dir: '${db_password}' }])).rejects.toThrow('must not contain `${`')
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

	test('when its setup extends another, by the locked form rather than an authored run section', async () => {
		const extending = 'zerops:\n  - setup: base\n    build:\n      base: alpine/bun@1.3\n  - setup: notesapi\n    extends: base\n'
		await expect(compile(contractApp({ zeropsSetup: 'notesapi' }), extending)).rejects.toThrow('zerops.yaml setup `notesapi` sets `extends`')
	})

	test('but not for a sibling setup of another placement, which never reaches it', async () => {
		const sibling = `${SPA_DESCRIPTOR}  - setup: other\n    run:\n      envVariables:\n        URL: \${proxy_FABRIKA_IAM_KEY}\n`
		const manifest = await compile(contractApp({ zeropsSetup: 'notesapi' }), sibling)
		expect(render(manifest)['setup']).toBe('notesapi')
	})

	test('runs the sweep and the scan of file kinds, as of file collections', () => {
		const withKinds: ContractArtifact = { ...notesArtifact, files: {}, fileKinds: { photos: { types: ['image/png'], maxBytes: 1024, scan: true } } }
		expect(zeropsContractRun(withKinds, contractDigest(withKinds))).toMatchObject({ files: true, scan: true })
		const unscanned: ContractArtifact = { ...withKinds, fileKinds: { photos: { types: ['image/png'], maxBytes: 1024 } } }
		expect(zeropsContractRun(unscanned, contractDigest(unscanned))).not.toHaveProperty('scan')
	})

	test('without a health endpoint for the readiness check', () => {
		const withoutHealth: ContractArtifact = { ...notesArtifact, endpoints: notesArtifact.endpoints.filter((row) => row.kind !== 'health') }
		expect(() => zeropsContractRun(withoutHealth, contractDigest(withoutHealth))).toThrow("c.health('/healthz')")
	})

	test('for a contract of another application', async () => {
		await expect(compile(contractApp({}, 'other'))).rejects.toThrow('the contract declares app `notes`, but the config is app `other`')
	})

	test('unless it is served behind the endpoint table of the same contract', async () => {
		const other: ContractArtifact = { ...notesArtifact, actions: { ...notesArtifact.actions, 'notes.export': 'Export notes' } }
		const sameContract = 'endpoint table of the same contract'
		await expect(compile(contractApp({ proxy: { upstream: 'notesapi:3000', ...contractProxyTable(other) } }))).rejects.toThrow(sameContract)
		await expect(compile(contractApp({ proxy: undefined }))).rejects.toThrow(sameContract)
	})

	test('when it ships an endpoint table without its contract', async () => {
		const withoutContract: ZeropsAppConfig = {
			id: 'notes',
			target: { platform: 'zerops', services: () => [API], proxy: { upstream: 'notesapi:3000', ...contractProxyTable(notesArtifact) } },
		}
		await expect(compile(withoutContract)).rejects.toThrow('carries its contract (`target.contract`)')
	})

	test('with two databases', async () => {
		await expect(compile(contractApp({ services: () => [DATABASE, { hostname: 'otherdb', type: 'postgresql:single@18' }, API] }))).rejects
			.toThrow('more than one')
	})

	test('with two buckets, because the runtime opens one', async () => {
		await expect(compile(contractApp({ services: () => [DATABASE, BUCKET, { ...BUCKET, hostname: 'notesmedia' }, API] }))).rejects
			.toThrow('a contract application has one object storage; it declares more than one')
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
