// Backlog 226: a deploy writes what its approved schema removes to IAM before anything publishes the new version, and
// the whole schema, widenings included, once the version is live. A narrowing IAM does not take fails the run with
// nothing published, so no version serves under rights IAM still grants.

import { ReconcileSchemaError } from '@fabrika/auth'
import type { AppSchema } from '@fabrika/auth-core'
import type { BlobStore } from '@fabrika/platform'
import { uuidv7 } from '@fabrika/platform'
import type { ControlProvider, ProviderDeployInput, ProviderNamespaceMember } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import type { ControlRepositories } from '../db'
import { narrowingOf } from '../iam-narrowing'
import type { IamSchemaPort } from '../iam-schema'
import { executeDeploy, type RunDeps } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { memoryCommits } from './helpers/commits'
import { BASE, edited } from './helpers/contracts'
import { createHarness } from './helpers/harness'
import { makeFakeLock } from './helpers/lock'
import { fixedProxySecrets } from './helpers/vault'

const OWNER_GRANTS = `owner: { grants: ['notes.read', 'notes.write', 'notes.delete']`
const EDITOR_GRANTS = `editor: { grants: ['notes.read', 'notes.write']`
/** The owner loses `notes.delete`: a narrowing only. */
const OWNER_NARROWED = edited(OWNER_GRANTS, `owner: { grants: ['notes.read', 'notes.write']`)
/** The editor gains `notes.delete`: a widening only. */
const EDITOR_WIDENED = edited(EDITOR_GRANTS, `editor: { grants: ['notes.read', 'notes.write', 'notes.delete']`)
/** Both: the owner loses `notes.delete` while the editor gains it. */
const BOTH = edited(EDITOR_GRANTS, `editor: { grants: ['notes.read', 'notes.write', 'notes.delete']`, OWNER_NARROWED)

interface World {
	readonly db: ControlRepositories
	readonly deploys: ProviderDeployInput[]
	readonly republished: Array<readonly ProviderNamespaceMember[]>
	readonly logs: Map<string, string>
	contract: string
	/** What IAM holds for `notes@stage`, and every write it was asked for, with how many deploys had started then. */
	readonly iam: { held: AppSchema | null; writes: Array<{ schema: AppSchema; deploysBefore: number; republishedBefore: number }> }
	/** What IAM answers the next write; it takes it otherwise. */
	refuse: Array<Error | null>
}

function world(): World {
	const { db } = createHarness()
	return { db, deploys: [], republished: [], logs: new Map(), contract: BASE, iam: { held: null, writes: [] }, refuse: [] }
}

function iam(w: World): IamSchemaPort {
	return {
		apply: (input) => {
			w.iam.writes.push({ schema: input.schema, deploysBefore: w.deploys.length, republishedBefore: w.republished.length })
			const refusal = w.refuse.shift() ?? null
			if (refusal !== null) return Promise.reject(refusal)
			w.iam.held = input.schema
			return Promise.resolve()
		},
	}
}

function provider(w: World): ControlProvider {
	return {
		id: 'harbor',
		normalizeRegistration: (input) => input,
		resolveSource: () => Promise.resolve({ commitSha: 'c'.repeat(40) }),
		deploy: (input) => {
			w.deploys.push(input)
			return Promise.resolve({ state: 'succeeded' })
		},
		namespaces: {
			normalize: (namespace) => namespace,
			namespaceResourceClaims: () => [],
			registrationResourceClaims: () => [],
			provision: (input) => Promise.resolve(input.namespace),
			reconcile: (input) => Promise.resolve(input.namespace),
			republish: (input) => {
				w.republished.push(input.members)
				return Promise.resolve({ namespace: input.namespace, settled: true })
			},
		},
	}
}

function deps(w: World): RunDeps {
	const logs: Pick<BlobStore, 'put'> = {
		put: (key, value) => {
			if (typeof value === 'string') w.logs.set(key, value)
			return Promise.resolve()
		},
	}
	return {
		repositories: w.db,
		provider: provider(w),
		proxySecrets: fixedProxySecrets,
		secrets: new VaultSecretResolver({}),
		lock: makeFakeLock(w.db),
		queue: { send: () => Promise.resolve() },
		logs,
		iamSchema: iam(w),
		commits: { ...memoryCommits(), open: (input) => memoryCommits({ 'fabrika.contract.ts': w.contract }).open(input) },
	}
}

async function seed(w: World): Promise<void> {
	await w.db.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
	await w.db.registry.createDeploymentNamespaceWithResourceClaims({
		id: 'apps-stage',
		env: 'stage',
		provider: 'harbor',
		exclusiveAppId: null,
		providerTargetJson: JSON.stringify({ provider: 'harbor', version: 1, payload: {} }),
		state: 'ready',
	}, [])
	await w.db.registry.upsertAppEnv({
		appId: 'notes',
		env: 'stage',
		domain: 'stage.notes.example.test',
		namespaceId: 'apps-stage',
		provider: 'harbor',
		providerTargetJson: JSON.stringify({ provider: 'harbor', version: 1, payload: {} }),
		providerArtifactJson: JSON.stringify({ provider: 'harbor', version: 1, payload: {} }),
	})
}

async function deploy(w: World): Promise<{ runId: string; status: string; log: string }> {
	const runId = uuidv7()
	await w.db.runs.createRun({ id: runId, appId: 'notes', env: 'stage', ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })
	const { status } = await executeDeploy(deps(w), { runId })
	const row = await w.db.runs.getRun(runId)
	return { runId, status, log: row?.log_key === null || row === null ? '' : w.logs.get(row.log_key) ?? '' }
}

const grantsOf = (schema: AppSchema | null | undefined, role: string): readonly string[] | undefined => schema?.roles[role]?.permissions

/** The running version deployed from `BASE`: IAM holds its schema. */
async function running(w: World): Promise<AppSchema> {
	await seed(w)
	expect((await deploy(w)).status).toBe('succeeded')
	const held = w.iam.held
	if (held === null) throw new Error('the first deploy wrote no schema')
	expect(grantsOf(held, 'owner')).toContain('notes.delete')
	w.iam.writes.length = 0
	w.deploys.length = 0
	w.republished.length = 0
	return held
}

describe('a deploy that narrows access', () => {
	test('a narrowing IAM refuses fails the run before anything is published, and leaves IAM as it was', async () => {
		for (const refusal of [new ReconcileSchemaError('role owner is held by an external principal', 409), new Error('connect ECONNREFUSED')]) {
			const w = world()
			const before = await running(w)
			w.contract = OWNER_NARROWED
			w.refuse = [refusal]

			const run = await deploy(w)

			expect(run.status).toBe('failed')
			expect(w.iam.writes).toHaveLength(1)
			expect(grantsOf(w.iam.writes[0]?.schema, 'owner')).not.toContain('notes.delete')
			// No proxy table and no version: the old one keeps serving under the rights IAM still grants.
			expect(w.republished).toEqual([])
			expect(w.deploys).toEqual([])
			expect(w.iam.held).toEqual(before)
			expect(run.log).toContain(`IAM did not take the narrowing of the authz schema, so the version is not published: ${refusal.message}`)
		}
	})

	test('a widening IAM refuses fails the run after the publish, as before', async () => {
		const w = world()
		const before = await running(w)
		w.contract = EDITOR_WIDENED
		w.refuse = [new ReconcileSchemaError('IAM refuses', 400)]

		const run = await deploy(w)

		expect(run.status).toBe('failed')
		expect(w.iam.writes).toHaveLength(1)
		expect(w.iam.writes[0]).toMatchObject({ deploysBefore: 1, republishedBefore: 1 })
		expect(w.deploys).toHaveLength(1)
		expect(w.iam.held).toEqual(before)
		expect(run.log).toContain('reconcile-schema failed: IAM refuses')
	})

	test('a schema that narrows and widens writes the narrowing before the publish and the whole schema after it', async () => {
		const w = world()
		await running(w)
		w.contract = BOTH

		expect((await deploy(w)).status).toBe('succeeded')

		expect(w.iam.writes).toHaveLength(2)
		const [narrowing, whole] = w.iam.writes
		expect(narrowing).toMatchObject({ deploysBefore: 0, republishedBefore: 0 })
		expect(grantsOf(narrowing?.schema, 'owner')).toEqual(['notes.read', 'notes.write'])
		// The widening waits for the version that needs it.
		expect(grantsOf(narrowing?.schema, 'editor')).toEqual(['notes.read', 'notes.write'])
		expect(whole).toMatchObject({ deploysBefore: 1, republishedBefore: 1 })
		expect(grantsOf(whole?.schema, 'editor')).toContain('notes.delete')
		expect(w.iam.held).toEqual(w.deploys[0]?.environment.access?.schema ?? null)
	})

	test('a deploy that narrows nothing writes the schema once, after the publish', async () => {
		const w = world()
		await running(w)
		w.contract = EDITOR_WIDENED

		expect((await deploy(w)).status).toBe('succeeded')
		expect(w.iam.writes.map((write) => write.deploysBefore)).toEqual([1])
	})
})

describe('narrowingOf', () => {
	const base: AppSchema = {
		scopes: [{ type: 'workspace', creator: 'owner', members: { manage: 'notes.manage', list: 'notes.read' } }],
		actions: [{ action: 'notes.read' }, { action: 'notes.write' }, { action: 'notes.manage' }],
		roles: {
			owner: { name: 'owner', permissions: ['notes.read', 'notes.write', 'notes.manage'], member: { scope: 'workspace', assignableBy: ['owner'] } },
			reader: { name: 'reader', permissions: ['notes.read'] },
		},
		contract: true,
		workloads: [{ kind: 'job', name: 'digest', actions: ['notes.read', 'notes.write'] }],
	}

	test('takes away what the new schema removes and adds nothing it adds', () => {
		const after: AppSchema = {
			...base,
			actions: [{ action: 'notes.read' }, { action: 'notes.manage' }, { action: 'notes.export' }],
			roles: {
				owner: { name: 'owner', permissions: ['notes.read', 'notes.manage', 'notes.export'], member: { scope: 'workspace', assignableBy: ['owner'] } },
				auditor: { name: 'auditor', permissions: ['notes.export'] },
			},
			workloads: [{ kind: 'job', name: 'digest', actions: ['notes.read', 'notes.export'] }, { kind: 'webhook', name: 'in', actions: ['notes.read'] }],
		}

		const narrowing = narrowingOf(base, after)

		if (narrowing.kind !== 'narrowing') throw new Error(`expected a narrowing, got ${narrowing.kind}`)
		expect(narrowing.schema.actions).toEqual([{ action: 'notes.read' }, { action: 'notes.manage' }])
		expect(narrowing.schema.roles).toEqual({
			owner: { name: 'owner', permissions: ['notes.read', 'notes.manage'], member: { scope: 'workspace', assignableBy: ['owner'] } },
		})
		expect(narrowing.schema.workloads).toEqual([{ kind: 'job', name: 'digest', actions: ['notes.read'] }])
		expect(narrowing.schema.scopes).toEqual(base.scopes)
	})

	test('a schema that only adds narrows nothing', () => {
		const after: AppSchema = {
			...base,
			actions: [...base.actions, { action: 'notes.export' }],
			roles: { ...base.roles, reader: { name: 'reader', permissions: ['notes.read', 'notes.export'] } },
		}
		expect(narrowingOf(base, after)).toEqual({ kind: 'none' })
	})

	test('a dimension that stops listing its members keeps the declaration, and a creator the new schema drops goes', () => {
		const after: AppSchema = {
			...base,
			scopes: [{ type: 'workspace' }],
			roles: { owner: base.roles.owner ?? { name: 'owner', permissions: [] } },
		}

		const narrowing = narrowingOf(base, after)

		if (narrowing.kind !== 'narrowing') throw new Error(`expected a narrowing, got ${narrowing.kind}`)
		// IAM deletes the membership transport key with the last dimension that lists members, which a later write does not
		// bring back; the creator, granted its role at a value's creation, goes.
		expect(narrowing.schema.scopes).toEqual([{ type: 'workspace', members: { manage: 'notes.manage', list: 'notes.read' } }])
		expect(Object.keys(narrowing.schema.roles)).toEqual(['owner'])
	})

	test('a changed creator and a removed workload keep the running values, so nothing is written ahead', () => {
		const after: AppSchema = {
			...base,
			scopes: [{ type: 'workspace', creator: 'reader', members: { manage: 'notes.manage', list: 'notes.read' } }],
			workloads: [],
		}
		// IAM revokes a removed workload's keys at once: a deploy failing after the ahead write would leave the running job without one.
		expect(narrowingOf(base, after)).toEqual({ kind: 'none' })
	})

	test('a link mount the new schema changes keeps its running definition and the actions it names', () => {
		const linked: AppSchema = {
			...base,
			actions: [...base.actions, { action: 'notes.share' }],
			links: { view: { dimension: 'workspace', grants: ['notes.read'], issuedBy: 'notes.share', maxDays: 30 } },
		}
		const after: AppSchema = {
			...linked,
			actions: [{ action: 'notes.read' }, { action: 'notes.write' }, { action: 'notes.manage' }, { action: 'notes.link' }],
			roles: { ...base.roles, reader: { name: 'reader', permissions: [] } },
			links: { view: { dimension: 'workspace', grants: ['notes.write'], issuedBy: 'notes.link', maxDays: 7 } },
		}

		const narrowing = narrowingOf(linked, after)

		if (narrowing.kind !== 'narrowing') throw new Error(`expected a narrowing, got ${narrowing.kind}`)
		// IAM revokes every link of a mount it no longer holds; the shorter lifetime applies to links issued from now on.
		expect(narrowing.schema.links).toEqual({ view: { dimension: 'workspace', grants: ['notes.read'], issuedBy: 'notes.share', maxDays: 7 } })
		expect(narrowing.schema.actions.map((action) => action.action)).toContain('notes.share')
		expect(narrowing.schema.roles.reader?.permissions).toEqual([])
	})

	test("a public procedure whose action is renamed keeps its own, and a role's narrowing still goes ahead", () => {
		// IAM refuses a role that grants a public procedure's action, so the procedure holds one no role does.
		const procedure: AppSchema = {
			...base,
			actions: [...base.actions, { action: 'notes.send' }],
			workloads: [{ kind: 'public', name: 'api.submit', actions: ['notes.send'] }],
		}
		const after: AppSchema = {
			...procedure,
			actions: [...base.actions, { action: 'notes.submit' }],
			roles: { ...base.roles, owner: { name: 'owner', permissions: ['notes.read'], member: { scope: 'workspace', assignableBy: ['owner'] } } },
			workloads: [{ kind: 'public', name: 'api.submit', actions: ['notes.submit'] }],
		}

		const narrowing = narrowingOf(procedure, after)

		if (narrowing.kind !== 'narrowing') throw new Error(`expected a narrowing, got ${narrowing.kind}`)
		expect(narrowing.schema.workloads).toEqual(procedure.workloads)
		expect(narrowing.schema.actions.map((action) => action.action)).toEqual(['notes.read', 'notes.write', 'notes.manage', 'notes.send'])
		expect(narrowing.schema.roles.owner?.permissions).toEqual(['notes.read'])
	})

	test('a kept delegation that creates values keeps its creator, and the creator role, holding nothing', () => {
		const creating: AppSchema = { ...base, delegations: { 'api.create': { action: 'notes.write', dimension: 'workspace', purpose: 'creates' } } }
		const after: AppSchema = {
			...base,
			scopes: [{ type: 'workspace', members: { manage: 'notes.manage', list: 'notes.read' } }],
			roles: { reader: { name: 'reader', permissions: [] } },
		}

		const narrowing = narrowingOf(creating, after)

		if (narrowing.kind !== 'narrowing') throw new Error(`expected a narrowing, got ${narrowing.kind}`)
		expect(narrowing.schema.scopes[0]?.creator).toBe('owner')
		expect(narrowing.schema.roles.owner).toEqual({ name: 'owner', permissions: [], member: { scope: 'workspace', assignableBy: [] } })
		expect(narrowing.schema.roles.reader?.permissions).toEqual([])
	})

	test("a job that issues a kept mount's links keeps the mount's actions while a role narrows", () => {
		const issuing: AppSchema = {
			...base,
			actions: [...base.actions, { action: 'notes.share' }],
			links: { view: { dimension: 'workspace', grants: ['notes.read'], issuedBy: 'notes.share', maxDays: 30 } },
			workloads: [{ kind: 'job', name: 'sharer', actions: ['notes.read', 'notes.share'], issues: 'view' }],
		}
		const after: AppSchema = {
			...issuing,
			actions: [...base.actions, { action: 'notes.link' }],
			roles: { ...base.roles, reader: { name: 'reader', permissions: [] } },
			links: { view: { dimension: 'workspace', grants: ['notes.read'], issuedBy: 'notes.link', maxDays: 30 } },
			workloads: [{ kind: 'job', name: 'sharer', actions: ['notes.read', 'notes.link'], issues: 'view' }],
		}

		const narrowing = narrowingOf(issuing, after)

		if (narrowing.kind !== 'narrowing') throw new Error(`expected a narrowing, got ${narrowing.kind}`)
		expect(narrowing.schema.workloads).toEqual(issuing.workloads)
		expect(narrowing.schema.roles.reader?.permissions).toEqual([])
	})

	test('an unchanged schema narrows nothing, an empty assigner list included', () => {
		const roles = { ...base.roles, owner: { name: 'owner', permissions: ['notes.read'], member: { scope: 'workspace', assignableBy: [] } } }
		expect(narrowingOf({ ...base, roles }, { ...base, roles })).toEqual({ kind: 'none' })
	})
})
