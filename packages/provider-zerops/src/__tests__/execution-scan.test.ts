// A contract with a `scan: true` file collection on Zerops: the generated run section installs ClamAV with its first
// signatures, refreshes them when a container starts and daily, and runs the framework's scan job every minute; the
// deploy service must start with the RAM one scan needs.

import { FILE_SCAN_JOB, FILE_SWEEP_JOB } from '@fabrika/app/build'
import { type ContractArtifact, contractDigest } from '@fabrika/auth-core'
import type { JsonValue } from '@fabrika/provider-contract'
import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { parseZeropsDescriptor } from '../descriptor'
import {
	FABRIKA_CHECK_VERSION,
	renderLockedExecutionDescriptor,
	ZEROPS_SCAN_MIN_RAM_GB,
	ZEROPS_START_MIN_RAM_GB,
	zeropsContractRun,
	zeropsStartMinRam,
} from '../execution'
import {
	compileFabrikaManifest,
	createZeropsArtifactSourceDescriptor,
	type FabrikaManifest,
	lockedExecutionFor,
	lockedExecutionOf,
} from '../manifest'
import type { ZeropsAppConfig, ZeropsServiceSpec } from '../types'

const DESCRIPTOR = 'zerops:\n  - setup: notesapi\n'
const DATABASE: ZeropsServiceSpec = { hostname: 'notesdb', type: 'postgresql:single@18' }

const attachments = notesArtifact.files['attachments']
if (attachments === undefined) throw new Error('the notes artifact has no attachments')
const SCANNING: ContractArtifact = { ...notesArtifact, files: { attachments: { ...attachments, scan: true } } }

const app = (contract: ContractArtifact, minRam: number | null): ZeropsAppConfig => ({
	id: 'notes',
	target: {
		platform: 'zerops',
		services: () => [DATABASE, { hostname: 'notesapi', type: 'alpine/bun@1.3', ...(minRam === null ? {} : { verticalAutoscaling: { minRam } }) }],
		deployService: 'notesapi',
		contract,
		proxy: { upstream: 'notesapi:3000', ...contractProxyTable(contract) },
	},
})

const compile = async (config: ZeropsAppConfig): Promise<FabrikaManifest> =>
	compileFabrikaManifest(config, 'prod', await createZeropsArtifactSourceDescriptor(DESCRIPTOR))

type Mapping = { readonly [key: string]: JsonValue }

const mapping = (value: JsonValue | undefined): Mapping => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected a mapping')
	return value
}

const run = (manifest: FabrikaManifest): Mapping => {
	const execution = lockedExecutionOf(manifest)
	if (execution === null) throw new Error('expected a contract application')
	const rendered = renderLockedExecutionDescriptor(manifest.target.sourceDescriptor.contents, manifest.target.zeropsSetup, 'r1', execution)
	const setups = parseZeropsDescriptor(rendered.contents).document['zerops']
	if (!Array.isArray(setups) || setups.length !== 1) throw new Error('expected one setup')
	return mapping(mapping(setups[0])['run'])
}

describe('a scanning contract on Zerops', () => {
	test('adds clamav and its first signatures to the image, a refresh at start, the scan job and the daily freshclam', async () => {
		const manifest = await compile(app(SCANNING, ZEROPS_SCAN_MIN_RAM_GB))
		expect(manifest.target.contract?.scan).toBe(true)
		const generated = run(manifest)
		expect(generated['prepareCommands']).toEqual(['sudo apk add --no-cache clamav', 'sudo freshclam --stdout --quiet'])
		expect(generated['initCommands']).toEqual([
			"sudo freshclam --stdout --quiet || echo 'fabrika: freshclam did not refresh the malware signatures'",
			'sh /var/www/fabrika/migrate.generated.sh',
			'sh /var/www/fabrika/verify.generated.sh',
		])
		expect(generated['crontab']).toEqual([
			{ timing: '0 3 * * *', command: './node_modules/.bin/fabrika job run purgeDeleted', allContainers: false },
			{ timing: '41 * * * *', command: `./node_modules/.bin/fabrika job run ${FILE_SWEEP_JOB}`, allContainers: false },
			{ timing: '* * * * *', command: `./node_modules/.bin/fabrika job run ${FILE_SCAN_JOB}`, allContainers: false },
			{ timing: '17 4 * * *', command: 'sudo freshclam --stdout --quiet', allContainers: true },
		])
	})

	test('a contract that does not scan installs nothing and keeps its run facts as they were', async () => {
		const manifest = await compile(app(notesArtifact, null))
		expect(Object.keys(manifest.target.contract ?? {})).not.toContain('scan')
		const generated = run(manifest)
		expect(generated['prepareCommands']).toBeUndefined()
		expect(generated['initCommands']).toEqual(['sh /var/www/fabrika/migrate.generated.sh', 'sh /var/www/fabrika/verify.generated.sh'])
		expect(JSON.stringify(generated['crontab'])).not.toContain(FILE_SCAN_JOB)
		expect(JSON.stringify(generated['crontab'])).toContain(FILE_SWEEP_JOB)
	})

	test('a contract without a file collection runs no sweep', async () => {
		const manifest = await compile(app({ ...notesArtifact, files: {} }, null))
		expect(Object.keys(manifest.target.contract ?? {})).not.toContain('files')
		expect(JSON.stringify(run(manifest)['crontab'])).not.toContain(FILE_SWEEP_JOB)
	})

	test('the deploy service must start with the RAM a scan needs, at build and at a deploy of an approved scanning contract', async () => {
		await expect(compile(app(SCANNING, null))).rejects.toThrow(
			`set verticalAutoscaling: { minRam: ${ZEROPS_SCAN_MIN_RAM_GB} } on the service \`notesapi\``,
		)
		await expect(compile(app(SCANNING, 1))).rejects.toThrow('needs 2 GB of RAM')
		const plain = await compile(app(notesArtifact, null))
		expect(zeropsContractRun(SCANNING, contractDigest(SCANNING)).scan).toBe(true)
		expect(() =>
			lockedExecutionFor(plain, {
				access: {
					contract: SCANNING,
					contractDigest: contractDigest(SCANNING),
					schema: { scopes: [], actions: [], roles: {} },
					checker: FABRIKA_CHECK_VERSION,
				},
			}, false)
		).toThrow(
			'needs 2 GB of RAM',
		)
	})
})

describe('the minimum RAM a deploy raises the deploy service to', () => {
	const minRamOf = (manifest: FabrikaManifest): number | null => {
		const execution = lockedExecutionOf(manifest)
		if (execution === null) throw new Error('expected a contract application')
		return zeropsStartMinRam(execution)
	}

	test("what the init commands' isolation tests need with a database, what a scan needs with a scanner, nothing without either", async () => {
		expect(minRamOf(await compile(app(notesArtifact, null)))).toBe(ZEROPS_START_MIN_RAM_GB)
		expect(minRamOf(await compile(app(SCANNING, ZEROPS_SCAN_MIN_RAM_GB)))).toBe(ZEROPS_SCAN_MIN_RAM_GB)
		const withoutDatabase: ZeropsAppConfig = {
			...app(notesArtifact, null),
			target: { ...app(notesArtifact, null).target, services: () => [{ hostname: 'notesapi', type: 'alpine/bun@1.3' }] },
		}
		expect(minRamOf(await compile(withoutDatabase))).toBeNull()
	})
})
