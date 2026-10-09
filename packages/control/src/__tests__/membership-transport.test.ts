// The membership transport key of an application environment (ADR-0022 rule 6): issued while the approved contract has
// a membership or share-link operation, sealed in the vault, rotated before IAM stops honouring it, and forgotten with
// the need.

import { type ContractArtifact, MAX_KEY_LIFETIME_SECONDS } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import {
	MEMBERSHIP_KEY_ROTATE_BELOW_SECONDS,
	type MembershipKeyIssuer,
	needsMembershipTransport,
	VaultMembershipTransport,
} from '../membership-transport'
import { Vault } from '../vault'
import { createHarness, queryRows } from './helpers/harness'

const VAULT_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)))
const T0 = 1_800_000_000

/** IAM's issuance as `membershipKeys.issue` does it: every key of the environment but `keep` and the new one is deleted. */
class RecordingIssuer implements MembershipKeyIssuer {
	readonly issued: { app: string; expiresAt: number; keep: string | null }[] = []
	readonly valid = new Set<string>()

	issue(input: { app: string; expiresAt: number; keep: string | null }) {
		this.issued.push({ ...input })
		const id = `key-${this.issued.length}`
		for (const live of [...this.valid]) {
			if (live !== input.keep) this.valid.delete(live)
		}
		this.valid.add(id)
		return Promise.resolve({ key: `px_membership_${this.issued.length}`, id, expiresAt: input.expiresAt })
	}
}

async function setup() {
	const harness = createHarness()
	const { registry, membershipKeys } = harness.repositories
	await registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
	await registry.upsertAppEnv({
		appId: 'notes',
		env: 'prod',
		namespaceId: null,
		provider: 'test',
		providerTargetJson: '{}',
		providerArtifactJson: '{}',
	})
	const vault = await Vault.create(harness.d1, VAULT_KEY)
	const issuer = new RecordingIssuer()
	const clock = { now: T0 }
	const transport = new VaultMembershipTransport(membershipKeys, () => Promise.resolve(vault), issuer, () => clock.now)
	return { harness, vault, issuer, clock, transport }
}

describe('needsMembershipTransport', () => {
	test("is the contract's delegated endpoints and share-link mounts", () => {
		expect(needsMembershipTransport(notesArtifact)).toBe(true)
		const withoutLinks: ContractArtifact = {
			...notesArtifact,
			mounts: Object.fromEntries(Object.entries(notesArtifact.mounts).filter(([, mount]) => mount.kind !== 'link')),
		}
		expect(needsMembershipTransport(withoutLinks)).toBe(true)
		const plain: ContractArtifact = { ...withoutLinks, endpoints: withoutLinks.endpoints.filter((row) => row.requirement?.kind !== 'action') }
		expect(needsMembershipTransport(plain)).toBe(false)
		expect(needsMembershipTransport(null)).toBe(false)
	})
})

describe('VaultMembershipTransport', () => {
	test('issues one key for <app>@<env> at the longest lifetime, and answers it while it is fresh', async () => {
		const { issuer, clock, transport } = await setup()
		expect(await transport.reconcile('notes', 'prod', true)).toBe('px_membership_1')
		expect(issuer.issued).toEqual([{ app: 'notes@prod', expiresAt: T0 + MAX_KEY_LIFETIME_SECONDS, keep: null }])
		clock.now = T0 + MAX_KEY_LIFETIME_SECONDS - MEMBERSHIP_KEY_ROTATE_BELOW_SECONDS - 1
		expect(await transport.reconcile('notes', 'prod', true)).toBe('px_membership_1')
		expect(issuer.issued).toHaveLength(1)
	})

	test('rotates once less than half its lifetime is left, keeping the active key until the new one is recorded', async () => {
		const { harness, issuer, clock, transport } = await setup()
		await transport.reconcile('notes', 'prod', true)
		clock.now = T0 + MAX_KEY_LIFETIME_SECONDS - MEMBERSHIP_KEY_ROTATE_BELOW_SECONDS + 1
		expect(await transport.reconcile('notes', 'prod', true)).toBe('px_membership_2')
		expect(issuer.issued.map((entry) => entry.keep)).toEqual([null, 'key-1'])
		expect(queryRows(harness.sqlite, 'SELECT label FROM vault')).toEqual([{ label: 'platform:membership-key:notes@prod' }])
	})

	test('a rotation whose record fails keeps the active key, and its retry deletes the orphan', async () => {
		const { harness, vault, issuer, clock } = await setup()
		const records = harness.repositories.membershipKeys
		let failNextPut = false
		const flaky = new VaultMembershipTransport(
			{
				get: (appId, env) => records.get(appId, env),
				delete: (appId, env) => records.delete(appId, env),
				put: (row) => {
					if (failNextPut) {
						failNextPut = false
						return Promise.reject(new Error('the database went away'))
					}
					return records.put(row)
				},
			},
			() => Promise.resolve(vault),
			issuer,
			() => clock.now,
		)
		await flaky.reconcile('notes', 'prod', true)
		clock.now = T0 + MAX_KEY_LIFETIME_SECONDS
		failNextPut = true
		await expect(flaky.reconcile('notes', 'prod', true)).rejects.toThrow('the database went away')
		expect([...issuer.valid].sort()).toEqual(['key-1', 'key-2'])
		expect(await flaky.reconcile('notes', 'prod', true)).toBe('px_membership_3')
		expect(issuer.issued.map((entry) => entry.keep)).toEqual([null, 'key-1', 'key-1'])
		expect([...issuer.valid].sort()).toEqual(['key-1', 'key-3'])
		expect(queryRows(harness.sqlite, 'SELECT label FROM vault')).toHaveLength(1)
	})

	test('stores only a vault ref, and the vault only ciphertext', async () => {
		const { harness, transport } = await setup()
		const key = await transport.reconcile('notes', 'prod', true)
		const stored = JSON.stringify([
			...queryRows(harness.sqlite, 'SELECT * FROM app_env_membership_keys'),
			...queryRows(harness.sqlite, 'SELECT * FROM vault'),
		])
		expect(stored).not.toContain(String(key))
	})

	test('forgets the key once the contract needs none, and issues none without need', async () => {
		const { harness, issuer, transport } = await setup()
		await transport.reconcile('notes', 'prod', true)
		expect(await transport.reconcile('notes', 'prod', false)).toBeNull()
		expect(await transport.reconcile('notes', 'prod', false)).toBeNull()
		expect(queryRows(harness.sqlite, 'SELECT * FROM app_env_membership_keys')).toEqual([])
		expect(queryRows(harness.sqlite, 'SELECT * FROM vault')).toEqual([])
		expect(issuer.issued).toHaveLength(1)
	})
})
