// The second-factor repository on both engines: a confirmation that replaces its recovery codes only when it confirmed,
// a code step and a recovery code accepted once, and a reset recorded only when it removed something. Postgres runs
// when FABRIKA_TEST_POSTGRES_URL is set and skips cleanly otherwise.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sealValue } from '../data-key'
import { type AuditEventInput, createPostgresIamRepositories, type IamRepositories } from '../db'
import { generateTotpSecret, recoveryCodeHash } from '../totp'
import { createHarness } from './helpers/harness'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

if (!hasPostgres) {
	console.warn(`second-factor-repository.test.ts ${skipReason}`)
}

let postgres: PostgresFixture | null = null

beforeAll(async () => {
	if (hasPostgres) postgres = await createPostgres('iam_second_factor')
})

afterAll(async () => {
	await postgres?.close()
})

const DATA_KEY = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(32)))
let seq = 0

function event(principalId: string, action: string): AuditEventInput {
	return {
		requestId: `request-${action}`,
		principalId,
		principalLabel: principalId,
		app: 'propustka',
		action,
		resourceType: 'principal',
		resourceId: principalId,
	}
}

async function actions(repositories: IamRepositories, principalId: string): Promise<string[]> {
	const events = await repositories.audit.listAuditEvents({ principalId, limit: 50 })
	return events.map((row) => row.action).sort()
}

const engines: { name: string; repositories: () => IamRepositories; skip: boolean }[] = [
	{ name: 'SQLite', repositories: () => createHarness().repositories, skip: false },
	{
		name: 'Postgres',
		repositories: () => {
			if (postgres === null) throw new Error('postgres')
			return createPostgresIamRepositories(postgres.db)
		},
		skip: !hasPostgres,
	},
]

for (const engine of engines) {
	describe.skipIf(engine.skip)(`second factors (${engine.name})`, () => {
		test('a confirmation writes its codes and record only once, and a reset removes both with one record', async () => {
			const repositories = engine.repositories()
			seq += 1
			const principal = await repositories.principals.createUser(`sf-sub-${seq}`, `sf-${seq}@example.com`)
			const id = principal.id
			const sealed = await sealValue(DATA_KEY, id, generateTotpSecret())
			expect(await repositories.secondFactors.begin(id, sealed)).toBe(true)
			const hashes = await Promise.all(['aaaa-bbbb-cccc-dddd', 'eeee-ffff-gggg-hhhh'].map((code) => recoveryCodeHash(id, code)))

			expect(
				await repositories.secondFactors.confirm(
					{ principalId: id, ciphertext: 'another secret', step: 1, recoveryCodeHashes: hashes },
					event(id, 'iam.second_factor.enrol'),
				),
			)
				.toBe(false)
			expect(await repositories.secondFactors.status(id)).toEqual({ confirmedAt: null, recoveryCodesLeft: 0 })

			expect(
				await repositories.secondFactors.confirm(
					{ principalId: id, ciphertext: sealed.ciphertext, step: 100, recoveryCodeHashes: hashes },
					event(id, 'iam.second_factor.enrol'),
				),
			)
				.toBe(true)
			expect(
				await repositories.secondFactors.confirm(
					{ principalId: id, ciphertext: sealed.ciphertext, step: 100, recoveryCodeHashes: hashes },
					event(id, 'iam.second_factor.enrol'),
				),
			)
				.toBe(false)
			expect((await repositories.secondFactors.status(id)).recoveryCodesLeft).toBe(2)
			// A repeated confirmation in the same second leaves the codes the first one showed.
			const repeated = await recoveryCodeHash(id, 'iiii-jjjj-kkkk-llll')
			expect(
				await repositories.secondFactors.confirm(
					{ principalId: id, ciphertext: sealed.ciphertext, step: 100, recoveryCodeHashes: [repeated] },
					event(id, 'iam.second_factor.enrol'),
				),
			)
				.toBe(false)
			expect((await repositories.secondFactors.status(id)).recoveryCodesLeft).toBe(2)
			expect(await repositories.secondFactors.spendRecoveryCode(id, repeated, event(id, 'iam.second_factor.recovery_code.use'))).toBe(false)
			// A confirmed factor is not replaced by a new start.
			expect(await repositories.secondFactors.begin(id, await sealValue(DATA_KEY, id, generateTotpSecret()))).toBe(false)

			expect(await repositories.secondFactors.acceptStep(id, 100)).toBe(false)
			expect(await repositories.secondFactors.acceptStep(id, 101)).toBe(true)
			expect(await repositories.secondFactors.acceptStep(id, 101)).toBe(false)

			const [first] = hashes
			if (first === undefined) throw new Error('hash')
			expect(await repositories.secondFactors.spendRecoveryCode(id, first, event(id, 'iam.second_factor.recovery_code.use'))).toBe(true)
			expect(await repositories.secondFactors.spendRecoveryCode(id, first, event(id, 'iam.second_factor.recovery_code.use'))).toBe(false)
			expect((await repositories.secondFactors.status(id)).recoveryCodesLeft).toBe(1)

			expect(await repositories.secondFactors.reset(id, event(id, 'iam.second_factor.reset'))).toBe(true)
			expect(await repositories.secondFactors.reset(id, event(id, 'iam.second_factor.reset'))).toBe(false)
			expect(await repositories.secondFactors.isConfirmed(id)).toBe(false)
			expect(await actions(repositories, id)).toEqual(['iam.second_factor.enrol', 'iam.second_factor.recovery_code.use', 'iam.second_factor.reset'])
		})
	})
}
