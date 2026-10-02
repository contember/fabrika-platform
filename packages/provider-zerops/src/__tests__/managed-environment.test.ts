import { describe, expect, test } from 'bun:test'
import { parseServiceEnvResponse } from '../api/service-env-response'
import type { ZeropsApi, ZeropsProcess, ZeropsServiceEnv } from '../api/types'
import { parseZeropsDescriptor } from '../descriptor'
import { admitManagedEnvironment, confirmCodelessManagedService, confirmFreshManagedService } from '../managed-environment/admission'
import {
	assertAuthoredManagedDocument,
	assertAuthoredManagedInputs,
	assertAuthoredManagedName,
	assertNoManagedReferences,
} from '../managed-environment/authored'
import { prepareManagedDescriptor } from '../managed-environment/descriptor'
import {
	type ConfirmedManagedEntry,
	createPendingBinding,
	encodeManagedCheckpoint,
	MANAGED_CHECKPOINT_MAX_BYTES,
	MANAGED_ENVIRONMENT_MARKER,
	MANAGED_KEYS,
	type ManagedCheckpoint,
	type ManagedOwner,
	managedReferenceNames,
	mapManagedKeys,
	parseManagedBinding,
	parseManagedCheckpoint,
	parseManagedMarker,
	parseManagedValues,
	serializeManagedMarker,
	serializeManagedOwner,
	verifyManagedCheckpoint,
} from '../managed-environment/protocol'
import { createManagedMarker, createManagedRecord } from '../managed-environment/staging'

const owner: ManagedOwner = {
	protocol: 1,
	appId: 'demo',
	environment: 'test',
	namespaceId: 'namespace',
	projectId: 'project',
	serviceId: 'service',
	hostname: 'demoapi',
}
const marker = { ...owner, creationProcessId: 'create-process', initialCodelessAppVersionId: 'codeless-version' }
const sentinel = 'SECRET-MUST-NEVER-APPEAR'

async function checkpoint(appVersionId = 'version-a'): Promise<Extract<ManagedCheckpoint, { phase: 'build_triggered' }>> {
	const names = await managedReferenceNames({ ...owner, appVersionId })
	return {
		...owner,
		runId: 'run-a',
		appVersionId,
		markerRecordId: 'marker-record',
		originalArtifactSha256: 'a'.repeat(64),
		descriptorSha256: 'b'.repeat(64),
		setup: 'api',
		sourceCommitSha: 'c'.repeat(40),
		phase: 'build_triggered',
		binding: mapManagedKeys((key): ConfirmedManagedEntry =>
			key === 'FABRIKA_OPERATIONS_DSN'
				? { state: 'absent' }
				: { state: 'confirmed', referenceName: names[key], backingRecordId: `record-${key}` }
		),
	}
}

function recordsFor(state: ManagedCheckpoint): ZeropsServiceEnv[] {
	const records: ZeropsServiceEnv[] = [{
		id: 'marker-record',
		key: MANAGED_ENVIRONMENT_MARKER,
		content: serializeManagedMarker(marker),
		type: 'USER',
		sensitive: true,
	}]
	for (const key of MANAGED_KEYS) {
		const entry = state.binding[key]
		if (entry.state !== 'confirmed') continue
		records.push({ id: `canonical-${key}`, key, content: `\${${entry.referenceName}}`, type: 'USER', sensitive: false })
		records.push({
			id: entry.backingRecordId,
			key: entry.referenceName,
			content: sentinel,
			type: 'USER',
			sensitive: true,
			serviceStackId: owner.serviceId,
		})
	}
	return records
}

function creationInput() {
	const finishedProcesses: ZeropsProcess[] = [
		{ id: 'create-process', actionName: 'stack.create', serviceStackId: owner.serviceId, status: 'FINISHED' },
		{ id: 'deploy-process', actionName: 'stack.deploy', serviceStackId: owner.serviceId, status: 'FINISHED', appVersionId: 'codeless-version' },
	]
	return {
		owner,
		provisioningDocument: { services: [{ hostname: owner.hostname, override: false, startWithoutCode: true }] },
		imported: {
			projectId: owner.projectId,
			services: [{ id: owner.serviceId, name: owner.hostname, processes: finishedProcesses.map((process) => ({ ...process, status: 'PENDING' })) }],
		},
		finishedProcesses,
		service: { id: owner.serviceId, name: owner.hostname, projectId: owner.projectId, activeAppVersionId: 'codeless-version' },
	}
}

describe('managed-environment protocol', () => {
	test('requires all six explicit values, preserves empty strings and null, refuses extras', () => {
		const values = mapManagedKeys(() => null)
		expect(parseManagedValues({ ...values, FABRIKA_RELEASE: '' }).FABRIKA_RELEASE).toBe('')
		expect(parseManagedValues(values)).toEqual(values)
		const { FABRIKA_RELEASE: _release, ...missing } = values
		for (const invalid of [missing, { ...values, EXTRA: sentinel }, { ...values, FABRIKA_RELEASE: undefined }, { ...values, FABRIKA_RELEASE: 1 }]) {
			expect(() => parseManagedValues(invalid)).toThrow('invalid managed-environment')
		}
	})

	test('names use the frozen tuple, 48 lowercase digest characters and fixed slots', async () => {
		const coordinates = { projectId: 'project', serviceId: 'service', appVersionId: 'version-a' }
		const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('[1,"project","service","version-a"]')))
		const digest = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 48)
		const names = await managedReferenceNames(coordinates)
		expect(names).toEqual({
			FABRIKA_RELEASE: `FABRIKA_MENV_${digest}_R`,
			FABRIKA_OPERATIONS_DSN: `FABRIKA_MENV_${digest}_D`,
			FABRIKA_IAM_ISSUER: `FABRIKA_MENV_${digest}_I`,
			FABRIKA_APP_ID: `FABRIKA_MENV_${digest}_A`,
			FABRIKA_ENVIRONMENT: `FABRIKA_MENV_${digest}_E`,
			FABRIKA_SERVICE_KEY: `FABRIKA_MENV_${digest}_S`,
		})
		for (const name of Object.values(names)) expect(name).toMatch(/^FABRIKA_MENV_[a-f0-9]{48}_[RDIAES]$/)
		expect(Object.values(names).every((name) => name.length === 63)).toBe(true)
		for (const field of ['projectId', 'serviceId', 'appVersionId']) {
			expect(await managedReferenceNames({ ...coordinates, [field]: 'different' })).not.toEqual(names)
		}
	})

	test('pending map carries absences and no values; later phases require confirmed IDs', async () => {
		const state = await checkpoint()
		const pending = await createPendingBinding(state, mapManagedKeys((key) => key === 'FABRIKA_RELEASE' ? sentinel : null))
		expect(pending.FABRIKA_RELEASE.state).toBe('pending')
		expect(pending.FABRIKA_OPERATIONS_DSN).toEqual({ state: 'absent' })
		const staging = { ...state, phase: 'managed_env_staging', binding: pending }
		expect(parseManagedCheckpoint(staging).phase).toBe('managed_env_staging')
		expect(JSON.stringify(parseManagedCheckpoint(staging))).not.toContain(sentinel)
		for (const phase of ['managed_env_staged', 'source_uploaded', 'build_trigger_requested', 'build_triggered']) {
			expect(() => parseManagedCheckpoint({ ...staging, phase })).toThrow()
		}
	})

	test('strict shape, coordinate-derived names, record uniqueness and phase-local process ID', async () => {
		const state = await checkpoint()
		expect(await verifyManagedCheckpoint(encodeManagedCheckpoint(state))).toEqual(state)
		await expect(verifyManagedCheckpoint({ ...state, serviceId: 'different' })).rejects.toThrow()
		await expect(verifyManagedCheckpoint({ ...state, appVersionId: 'different' })).rejects.toThrow()
		const release = state.binding.FABRIKA_RELEASE
		if (release.state !== 'confirmed') throw new Error('fixture requires release')
		const issuer = state.binding.FABRIKA_IAM_ISSUER
		if (issuer.state !== 'confirmed') throw new Error('fixture requires issuer')
		for (
			const invalid of [
				{ ...state, protocol: 2 },
				{ ...state, phase: 'unknown' },
				{ ...state, phase: 'source_uploaded', processId: 'process' },
				{ ...state, processId: undefined },
				{ ...state, uploadUrl: sentinel },
				{ ...state, originalArtifactSha256: 'invalid' },
				{ ...state, sourceCommitSha: 'main' },
				{ ...state, binding: { ...state.binding, FABRIKA_RELEASE: { ...release, value: sentinel } } },
				{ ...state, binding: { ...state.binding, FABRIKA_RELEASE: { ...release, backingRecordId: state.markerRecordId } } },
				{ ...state, binding: { ...state.binding, FABRIKA_IAM_ISSUER: { ...issuer, backingRecordId: release.backingRecordId } } },
				{ ...state, binding: { ...state.binding, FABRIKA_IAM_ISSUER: release } },
				{ ...state, binding: { ...state.binding, FABRIKA_OPERATIONS_DSN: { state: 'absent', referenceName: release.referenceName } } },
			]
		) expect(() => parseManagedCheckpoint(invalid)).toThrow('invalid managed-environment')
		const { FABRIKA_RELEASE: _entry, ...missing } = state.binding
		expect(() => parseManagedBinding(missing)).toThrow()
		expect(parseManagedCheckpoint({ ...state, processId: 'process' })).toHaveProperty('processId', 'process')
	})

	test('checkpoint UTF-8 encoding accepts exactly 16 KiB and rejects one byte more', async () => {
		const state = await checkpoint()
		const base = { ...state, setup: 'é' }
		const size = new TextEncoder().encode(JSON.stringify(base)).byteLength
		const exact = { ...base, setup: `é${'x'.repeat(MANAGED_CHECKPOINT_MAX_BYTES - size)}` }
		expect(new TextEncoder().encode(JSON.stringify(parseManagedCheckpoint(exact))).byteLength).toBe(MANAGED_CHECKPOINT_MAX_BYTES)
		expect(() => parseManagedCheckpoint({ ...exact, setup: `${exact.setup}x` })).toThrow()
	})

	test('marker roundtrip is exact, unknown fields and malformed JSON are redacted', () => {
		expect(parseManagedMarker(serializeManagedMarker(marker))).toEqual(marker)
		for (
			const contents of [
				sentinel,
				JSON.stringify({ ...marker, value: sentinel }),
				JSON.stringify({ ...marker, hostname: 'not-valid' }),
				serializeManagedOwner(owner),
			]
		) {
			try {
				parseManagedMarker(contents)
				throw new Error('expected refusal')
			} catch (error) {
				expect(error).toBeInstanceOf(Error)
				expect(String(error)).not.toContain(sentinel)
				expect(String(error)).toContain('invalid managed-environment')
			}
		}
	})

	test('marker requires both immutable bootstrap coordinates and rejects a mutable version pointer', () => {
		const { creationProcessId: _creation, ...withoutCreation } = marker
		const { initialCodelessAppVersionId: _version, ...withoutVersion } = marker
		for (
			const invalid of [
				withoutCreation,
				withoutVersion,
				{ ...marker, creationProcessId: '' },
				{ ...marker, initialCodelessAppVersionId: '' },
				{ ...marker, currentAppVersionId: 'candidate' },
			]
		) expect(() => parseManagedMarker(JSON.stringify(invalid))).toThrow('invalid managed-environment')
	})
})

describe('managed-environment ownership admission', () => {
	test('creation needs exact import association and every completed process, not discovery', () => {
		const input = creationInput()
		expect(confirmFreshManagedService(input)).toEqual({
			projectId: owner.projectId,
			serviceId: owner.serviceId,
			hostname: owner.hostname,
			creationProcessId: 'create-process',
		})
		expect(confirmCodelessManagedService(input).codelessAppVersionId).toBe('codeless-version')
		for (
			const invalid of [
				{ ...input, imported: { ...input.imported, projectId: 'foreign' } },
				{ ...input, imported: { ...input.imported, services: [] } },
				{ ...input, provisioningDocument: { services: [{ hostname: owner.hostname, override: true, startWithoutCode: true }] } },
				{ ...input, service: { ...input.service, id: 'foreign' } },
				{ ...input, finishedProcesses: input.finishedProcesses.slice(0, 1) },
				{ ...input, finishedProcesses: [...input.finishedProcesses, ...input.finishedProcesses] },
				{ ...input, finishedProcesses: input.finishedProcesses.map((process) => ({ ...process, status: 'FAILED' })) },
				{ ...input, finishedProcesses: input.finishedProcesses.map((process) => ({ ...process, serviceStackId: 'foreign' })) },
				{ ...input, finishedProcesses: input.finishedProcesses.map((process) => ({ ...process, id: 'unreported' })) },
				{ ...input, finishedProcesses: input.finishedProcesses.map((process) => ({ ...process, actionName: 'stack.deploy' })) },
				{ ...input, finishedProcesses: input.finishedProcesses.map(({ serviceStackId: _id, ...process }) => process) },
			]
		) expect(() => confirmFreshManagedService(invalid)).toThrow()
		const missingAssociation = {
			...input,
			imported: {
				...input.imported,
				services: input.imported.services.map((service) => ({
					...service,
					processes: service.processes.map(({ serviceStackId: _id, ...process }) => process),
				})),
			},
		}
		expect(() => confirmFreshManagedService(missingAssociation)).toThrow()
	})

	test('missing codeless version evidence does not prevent proving creation but refuses bootstrap', () => {
		const input = creationInput()
		const withoutVersion = {
			...input,
			imported: {
				...input.imported,
				services: input.imported.services.map((service) => ({
					...service,
					processes: service.processes.map(({ appVersionId: _id, ...process }) => process),
				})),
			},
			finishedProcesses: input.finishedProcesses.map(({ appVersionId: _id, ...process }) => process),
		}
		expect(confirmFreshManagedService(withoutVersion).serviceId).toBe(owner.serviceId)
		expect(() => confirmCodelessManagedService(withoutVersion)).toThrow()
		expect(() => confirmCodelessManagedService({ ...input, service: { ...input.service, activeAppVersionId: 'other' } })).toThrow()
		expect(() =>
			confirmCodelessManagedService({
				...input,
				provisioningDocument: {
					services: input.provisioningDocument.services.map((service) => ({ ...service, buildFromGit: 'https://example.test/repo' })),
				},
			})
		).toThrow()
	})

	test('non-sensitive USER canonical references and sensitive USER backing records admit an observed rollback binding', async () => {
		const prior = await checkpoint('old-rollback-version')
		const admitted = await admitManagedEnvironment({
			owner,
			records: recordsFor(prior),
			observedActiveAppVersionId: prior.appVersionId,
			prior: { kind: 'retained', checkpoint: prior },
		})
		expect(admitted.binding).toEqual(prior.binding)
		expect(admitted.markerRecordId).toBe('marker-record')
		expect(JSON.stringify(admitted)).not.toContain(sentinel)
		await expect(
			admitManagedEnvironment({
				owner,
				records: recordsFor(prior),
				observedActiveAppVersionId: 'newer-version',
				prior: { kind: 'retained', checkpoint: prior },
			}),
		).rejects.toThrow()
	})

	test('marker and backing records require sensitive true even when their type is SECRET', async () => {
		const prior = await checkpoint()
		const release = prior.binding.FABRIKA_RELEASE
		if (release.state !== 'confirmed') throw new Error('fixture requires release')
		for (const target of [MANAGED_ENVIRONMENT_MARKER, release.referenceName]) {
			for (const flag of ['false', 'missing']) {
				const records = recordsFor(prior).map((entry) => {
					if (entry.key !== target) return entry
					const { sensitive: _sensitive, ...rest } = entry
					return { ...rest, type: 'SECRET', ...(flag === 'false' ? { sensitive: false } : {}) }
				})
				await expect(
					admitManagedEnvironment({ owner, records, observedActiveAppVersionId: prior.appVersionId, prior: { kind: 'retained', checkpoint: prior } }),
				).rejects.toThrow()
			}
		}
	})

	test('refuses missing marker, literals, unknown/mixed references, ID replacement and absence violations', async () => {
		const prior = await checkpoint()
		const records = recordsFor(prior)
		const release = prior.binding.FABRIKA_RELEASE
		if (release.state !== 'confirmed') throw new Error('fixture requires release')
		for (
			const invalid of [
				records.filter((entry) => entry.key !== MANAGED_ENVIRONMENT_MARKER),
				records.map((entry) =>
					entry.key === MANAGED_ENVIRONMENT_MARKER ? { ...entry, content: serializeManagedMarker({ ...marker, environment: 'other' }) } : entry
				),
				records.map((entry) => entry.key === MANAGED_ENVIRONMENT_MARKER ? { ...entry, id: 'replaced-marker' } : entry),
				records.map((entry) => entry.key === 'FABRIKA_RELEASE' ? { ...entry, content: sentinel } : entry),
				records.map((entry) => entry.key === 'FABRIKA_RELEASE' ? { ...entry, content: '${unknown}' } : entry),
				records.map((entry) => entry.key === release.referenceName ? { ...entry, id: 'replacement' } : entry),
				records.map((entry) => entry.key === release.referenceName ? { ...entry, sensitive: false } : entry),
				records.filter((entry) => entry.key !== release.referenceName),
				[...records, { id: 'unexpected', key: 'FABRIKA_OPERATIONS_DSN', content: '', type: 'USER' }],
				[...records, ...records],
			]
		) {
			await expect(
				admitManagedEnvironment({
					owner,
					records: invalid,
					observedActiveAppVersionId: prior.appVersionId,
					prior: { kind: 'retained', checkpoint: prior },
				}),
			).rejects.toThrow()
		}
		const other = await checkpoint('other')
		const otherRelease = other.binding.FABRIKA_RELEASE
		if (otherRelease.state !== 'confirmed') throw new Error('fixture requires release')
		const mixed = records.map((entry) =>
			entry.key === 'FABRIKA_RELEASE'
				? { ...entry, content: `\${${otherRelease.referenceName}}` }
				: entry
		)
		await expect(
			admitManagedEnvironment({ owner, records: mixed, observedActiveAppVersionId: prior.appVersionId, prior: { kind: 'retained', checkpoint: prior } }),
		).rejects.toThrow()
	})

	test('a submission-intent checkpoint can own an activated version, while an unsubmitted map cannot', async () => {
		const prior = await checkpoint()
		const records = recordsFor(prior)
		for (const phase of ['build_trigger_requested', 'source_uploaded']) {
			const admission = admitManagedEnvironment({
				owner,
				records,
				observedActiveAppVersionId: prior.appVersionId,
				prior: { kind: 'retained', checkpoint: { ...prior, phase } },
			})
			if (phase === 'build_trigger_requested') await expect(admission).resolves.toHaveProperty('binding', prior.binding)
			else await expect(admission).rejects.toThrow()
		}
	})

	test('all-absent prior binding still requires the observed version; bootstrap requires the immutable marker version', async () => {
		const prior: ManagedCheckpoint = { ...await checkpoint(), phase: 'build_triggered', binding: mapManagedKeys(() => ({ state: 'absent' })) }
		const records = recordsFor(prior)
		await expect(
			admitManagedEnvironment({ owner, records, observedActiveAppVersionId: prior.appVersionId, prior: { kind: 'retained', checkpoint: prior } }),
		).resolves.toHaveProperty('binding', prior.binding)
		await expect(admitManagedEnvironment({ owner, records, observedActiveAppVersionId: null, prior: { kind: 'retained', checkpoint: prior } })).rejects
			.toThrow()
		const evidence = confirmCodelessManagedService(creationInput())
		await expect(
			admitManagedEnvironment({ owner, records, observedActiveAppVersionId: evidence.codelessAppVersionId, prior: { kind: 'bootstrap' } }),
		).resolves.toHaveProperty('binding', prior.binding)
		await expect(admitManagedEnvironment({ owner, records, observedActiveAppVersionId: prior.appVersionId, prior: { kind: 'bootstrap' } }))
			.rejects.toThrow()
		await expect(
			admitManagedEnvironment({ owner, records: [], observedActiveAppVersionId: evidence.codelessAppVersionId, prior: { kind: 'bootstrap' } }),
		).rejects.toThrow()
	})
})

describe('managed-environment authored policy and descriptor overlay', () => {
	const source =
		'zerops:\n  - setup: api\n    build:\n      buildCommands: echo build\n    run:\n      start: bun app.ts\n      envVariables:\n        KEEP: unchanged\n  - setup: worker\n    run:\n      start: bun worker.ts\n'

	test('overlays only selected setup with references, preserves source and explicit absence', async () => {
		const state = await checkpoint()
		const original = parseZeropsDescriptor(source)
		const before = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
		const rendered = prepareManagedDescriptor(source, 'api', state.binding)
		expect(rendered.setup).toBe('api')
		expect(rendered.contents).toContain('KEEP: unchanged')
		expect(rendered.contents).not.toContain('FABRIKA_OPERATIONS_DSN')
		expect(rendered.contents).not.toContain(sentinel)
		for (const key of MANAGED_KEYS) {
			const entry = state.binding[key]
			if (entry.state === 'confirmed') {
				expect(rendered.contents).toContain(key)
				expect(rendered.contents).toContain(`\${${entry.referenceName}}`)
			}
		}
		const entries = parseZeropsDescriptor(rendered.contents).document['zerops']
		const originals = original.document['zerops']
		if (!Array.isArray(entries) || !Array.isArray(originals)) throw new Error('fixture requires setups')
		expect(entries[1]).toEqual(originals[1])
		expect(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))).toEqual(before)
		expect(() => prepareManagedDescriptor(source, undefined, state.binding)).toThrow()
		expect(() => prepareManagedDescriptor(source, 'absent', state.binding)).toThrow()
	})

	test('all six absent means no canonical keys; source definitions cannot be overwritten', () => {
		const binding = mapManagedKeys((): ConfirmedManagedEntry => ({ state: 'absent' }))
		const rendered = prepareManagedDescriptor('zerops:\n  - setup: api\n    run:\n      start: bun app.ts\n', undefined, binding)
		for (const key of MANAGED_KEYS) expect(rendered.contents).not.toContain(key)
		expect(() => prepareManagedDescriptor(source.replace('KEEP:', 'FABRIKA_RELEASE:'), 'api', binding)).toThrow()
	})

	test('checks parsed encoded references in every setup and both build/run environments', () => {
		for (const phase of ['build', 'run']) {
			const contents = `zerops:\n  - setup: api\n    ${phase}:\n      envVariables:\n        ATTACK: "\\x24{demoapi_FABRIKA_MENV_PROTOCOL}"\n`
			expect(() => assertAuthoredManagedDocument(parseZeropsDescriptor(contents).document)).toThrow()
		}
		expect(() =>
			assertAuthoredManagedDocument({ zerops: [{ setup: 'api' }, { setup: 'other', run: { envVariables: { FABRIKA_RELEASE: 'app-owned' } } }] })
		).toThrow()
		for (const name of [MANAGED_ENVIRONMENT_MARKER, 'FABRIKA_MENV_CUSTOM', ...MANAGED_KEYS]) {
			expect(() => assertAuthoredManagedName(name)).toThrow()
			expect(() => assertAuthoredManagedInputs({ variableNames: [name], secretNames: [] })).toThrow()
			expect(() => assertAuthoredManagedInputs({ variableNames: [], secretNames: [name] })).toThrow()
		}
	})

	test('rejects direct, service and runtime references, secret values and composed final documents', () => {
		for (
			const value of [
				'${FABRIKA_MENV_PROTOCOL}',
				'${demoapi_FABRIKA_MENV_PROTOCOL}',
				'${RUNTIME_demoapi_FABRIKA_MENV_PROTOCOL}',
				'${RUNTIME_FABRIKA_MENV_PROTOCOL}',
			]
		) {
			expect(() => assertNoManagedReferences(value)).toThrow()
			expect(() => assertAuthoredManagedInputs({ variableNames: [], secretNames: ['TOKEN'], secretValues: { TOKEN: value } })).toThrow()
		}
		const left = '${demoapi_FABRIKA_'
		const right = 'MENV_PROTOCOL}'
		expect(() => assertNoManagedReferences(left)).not.toThrow()
		expect(() => assertNoManagedReferences(right)).not.toThrow()
		expect(() => assertAuthoredManagedDocument({ services: [{ envVariables: { TOKEN: left + right } }] })).toThrow()
		expect(() => assertAuthoredManagedDocument({ run: { start: 'echo ${FABRIKA_RELEASE}', envVariables: { DB: '${postgres_connectionString}' } } })).not
			.toThrow()
	})
})

describe('managed-environment create-only staging', () => {
	async function fixture() {
		const key = (await managedReferenceNames({ ...owner, appVersionId: 'candidate' })).FABRIKA_RELEASE
		const writes: Array<{ key: string; value: string }> = []
		const sleeps: number[] = []
		const records: ZeropsServiceEnv[] = []
		const controller = new AbortController()
		const api: Pick<ZeropsApi, 'createServiceEnv' | 'listServiceEnv'> = {
			createServiceEnv: async (input) => {
				writes.push({ key: input.key, value: input.value })
				records.push({ id: 'new-record', key: input.key, content: input.value, type: 'USER', sensitive: true, serviceStackId: input.serviceId })
			},
			listServiceEnv: async () => records,
		}
		const input = {
			api,
			serviceId: owner.serviceId,
			key,
			value: sentinel,
			signal: controller.signal,
			sleep: async (ms: number) => {
				sleeps.push(ms)
			},
			attempts: 3,
		}
		return { input, api, writes, records, sleeps, controller }
	}

	test('returns an observed ID, performs one create and never needs update/delete capabilities', async () => {
		const f = await fixture()
		expect(await createManagedRecord(f.input)).toEqual({ referenceName: f.input.key, backingRecordId: 'new-record' })
		expect(f.writes).toHaveLength(1)
		expect(f.sleeps).toHaveLength(0)
	})

	test('lost create response succeeds only with exact original-value readback', async () => {
		const f = await fixture()
		const create = f.api.createServiceEnv
		f.api.createServiceEnv = async (input) => {
			await create(input)
			throw new Error(sentinel)
		}
		expect(await createManagedRecord(f.input)).toHaveProperty('backingRecordId', 'new-record')
		expect(f.writes).toHaveLength(1)
	})

	test('empty intended values are confirmed without becoming absence', async () => {
		const f = await fixture()
		expect(await createManagedRecord({ ...f.input, value: '' })).toHaveProperty('backingRecordId', 'new-record')
		expect(f.records[0]?.content).toBe('')
	})

	test('invalid retry bounds and direct marker writes are refused before effects', async () => {
		const f = await fixture()
		for (const attempts of [0, 31, 1.5, Number.NaN]) {
			await expect(createManagedRecord({ ...f.input, attempts })).rejects.toThrow()
		}
		await expect(createManagedRecord({ ...f.input, key: MANAGED_ENVIRONMENT_MARKER })).rejects.toThrow()
		expect(f.writes).toHaveLength(0)
	})

	test('retries absent/transient readback within its attempt bound, without a second create', async () => {
		const f = await fixture()
		let reads = 0
		f.api.listServiceEnv = async () => {
			reads++
			if (reads === 1) throw new Error(sentinel)
			return reads === 2 ? [] : f.records
		}
		expect(await createManagedRecord(f.input)).toHaveProperty('backingRecordId', 'new-record')
		expect(reads).toBe(3)
		expect(f.sleeps).toHaveLength(2)
		expect(f.writes).toHaveLength(1)
	})

	test('mismatch, replaced ID, wrong association, non-sensitive records and duplicates never confirm or disclose values', async () => {
		for (const variant of ['value', 'id', 'association', 'sensitive-false', 'sensitive-missing', 'duplicate', 'empty-id']) {
			const f = await fixture()
			f.api.listServiceEnv = async () => {
				const record: ZeropsServiceEnv = {
					id: variant === 'empty-id' ? '' : 'replacement',
					key: f.input.key,
					content: variant === 'value' ? 'other' : sentinel,
					type: variant === 'sensitive-missing' ? 'SECRET' : 'USER',
					...(variant === 'sensitive-missing' ? {} : { sensitive: variant !== 'sensitive-false' }),
					serviceStackId: variant === 'association' ? 'foreign' : owner.serviceId,
				}
				return variant === 'duplicate' ? [record, record] : [record]
			}
			try {
				await createManagedRecord({ ...f.input, ...(variant === 'id' ? { expectedRecordId: 'expected-original' } : {}) })
				throw new Error('expected refusal')
			} catch (error) {
				expect(String(error)).not.toContain(sentinel)
				expect(String(error)).not.toContain('expected refusal')
			}
			expect(f.writes).toHaveLength(1)
			expect(f.sleeps).toHaveLength(0)
		}
	})

	test('unconfirmed lost response fails boundedly; interrupted work cannot start another effect', async () => {
		const f = await fixture()
		let reads = 0
		f.api.createServiceEnv = async () => {
			throw new Error(sentinel)
		}
		f.api.listServiceEnv = async () => {
			reads++
			return []
		}
		await expect(createManagedRecord(f.input)).rejects.toThrow('create-only confirmation failed')
		expect(reads).toBe(3)
		expect(f.sleeps).toHaveLength(2)
		const interrupted = await fixture()
		const leaseLost = new Error('lease lost')
		interrupted.api.createServiceEnv = async () => {
			interrupted.controller.abort(leaseLost)
		}
		interrupted.api.listServiceEnv = async () => {
			throw new Error('must not read after lease loss')
		}
		await expect(createManagedRecord(interrupted.input)).rejects.toBe(leaseLost)
	})

	test('marker creation requires fresh matching evidence and absent canonical variables', async () => {
		const f = await fixture()
		const creation = confirmCodelessManagedService(creationInput())
		expect(await createManagedMarker({ ...f.input, owner, creation })).toEqual({ markerRecordId: 'new-record' })
		expect(f.writes[0]).toEqual({ key: MANAGED_ENVIRONMENT_MARKER, value: serializeManagedMarker(marker) })
		const mismatched = await fixture()
		await expect(createManagedMarker({ ...mismatched.input, owner, creation: { ...creation, serviceId: 'foreign' } })).rejects.toThrow()
		expect(mismatched.writes).toHaveLength(0)
		const legacy = await fixture()
		legacy.records.push({ id: 'legacy', key: 'FABRIKA_RELEASE', content: sentinel, type: 'SECRET' })
		await expect(createManagedMarker({ ...legacy.input, owner, creation })).rejects.toThrow()
		expect(legacy.writes).toHaveLength(0)
	})

	test('verified bootstrap survives registration and first-deploy boundaries using only persisted marker evidence', async () => {
		const registration = await fixture()
		await createManagedMarker({ ...registration.input, owner, creation: confirmCodelessManagedService(creationInput()) })
		const persisted: unknown = JSON.parse(JSON.stringify(registration.records))
		const records = parseServiceEnvResponse({ items: persisted }, owner.serviceId)
		const firstDeploy = await admitManagedEnvironment({
			owner,
			records,
			observedActiveAppVersionId: marker.initialCodelessAppVersionId,
			prior: { kind: 'bootstrap' },
		})
		expect(firstDeploy.markerRecordId).toBe('new-record')
		expect(firstDeploy.binding).toEqual(mapManagedKeys(() => ({ state: 'absent' })))
		await expect(admitManagedEnvironment({ owner, records, observedActiveAppVersionId: 'candidate', prior: { kind: 'bootstrap' } })).rejects.toThrow()
	})

	test('repeated marker creation confirms the same evidence but cannot replace its initial version', async () => {
		const f = await fixture()
		const creation = confirmCodelessManagedService(creationInput())
		await createManagedMarker({ ...f.input, owner, creation })
		const saved = JSON.stringify(f.records)
		let duplicateAttempts = 0
		f.api.createServiceEnv = async () => {
			duplicateAttempts++
			throw new Error('duplicate')
		}
		await expect(createManagedMarker({ ...f.input, owner, creation })).resolves.toEqual({ markerRecordId: 'new-record' })
		await expect(createManagedMarker({ ...f.input, owner, creation: { ...creation, codelessAppVersionId: 'candidate' } })).rejects.toThrow(
			'confirmation failed',
		)
		expect(duplicateAttempts).toBe(2)
		expect(JSON.stringify(f.records)).toBe(saved)
		expect(f.writes).toHaveLength(1)
	})

	test('marker readback refuses false or missing sensitivity despite a SECRET type', async () => {
		for (const flag of ['false', 'missing']) {
			const f = await fixture()
			const create = f.api.createServiceEnv
			f.api.createServiceEnv = async (input) => {
				await create(input)
				const record = f.records[0]
				if (record === undefined) throw new Error('fixture requires a created marker')
				const { sensitive: _sensitive, ...rest } = record
				f.records[0] = { ...rest, type: 'SECRET', ...(flag === 'false' ? { sensitive: false } : {}) }
			}
			await expect(createManagedMarker({ ...f.input, owner, creation: confirmCodelessManagedService(creationInput()) })).rejects.toThrow(
				'confirmation failed',
			)
			expect(f.writes).toHaveLength(1)
		}
	})
})
