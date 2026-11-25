// ADR-0050 §5 end to end: deciding an approval request, and weakening what deciding takes, with Control's real IAM
// client over IAM's admin transport (`IAM_ADMIN`), answered by IAM's own app in process with its real WebAuthn verifier.
// The authenticator is IAM's test one, a WebCrypto key pair; the approver's console token is one IAM signed for a
// signed-in session.

import type { AuthContext, DomainEvent } from '@fabrika/auth'
import { permits } from '@fabrika/auth-core'
import {
	type ApprovalStepUp,
	type ApprovalStepUpChallenge,
	CONTROL_ACTIONS,
	type ProtectionChallengeInput,
	STRICT_POLICY,
	STRICT_SETTINGS,
} from '@fabrika/control-contract'
import type { PasskeyChallenge, PasskeyCreationOptions, PasskeyDto } from '@fabrika/iam-contract'
import { type HttpService, SqlDeployLocks, uuidv7 } from '@fabrika/platform'
import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import { adminTokenFor, CONSOLE_APP, createHarness as createIamHarness, TEST_SIGNING_KEYS } from '../../../iam/src/__tests__/helpers/harness'
import { TestAuthenticator } from '../../../iam/src/__tests__/helpers/webauthn'
import { createIamApp } from '../../../iam/src/app'
import type { IamRepositories } from '../../../iam/src/db'
import { ControlApiError } from '../api/domain'
import { type ApprovalUseCaseContext, challengeProtectionUseCase, setEnvironmentProtectionUseCase } from '../approval/api'
import { appEnvSettings } from '../approval/categories'
import { type ApprovalRequestContext, challengeApprovalRequestUseCase, decideApprovalRequestUseCase } from '../approval/requests/api'
import { jsonDigest } from '../approval/requests/rules'
import { iamPasskeyStepUp } from '../approval/step-up'
import type { ControlRepositories } from '../db'
import { createHarness, harnessDatabase } from './helpers/harness'

const ISSUER = 'https://iam.example.test'
const CONSOLE = 'https://console.example.test'
const ENVELOPE = JSON.stringify({ provider: 'harbor', version: 1, payload: {} })

/** IAM's own app behind the transport Control's IAM gateway uses. */
function iamTransport(repositories: IamRepositories): HttpService {
	return {
		fetch: (request) =>
			createIamApp().fetch(request, {
				DB: unusedDatabase,
				REPOSITORIES: repositories,
				HUMAN_EMAIL_DOMAINS: '[]',
				HUMAN_EMAILS: '[]',
				IAM_BOOTSTRAP_ADMINS: '[]',
				ENVIRONMENT: 'stage',
				ISSUER,
				FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
				FABRIKA_IAM_PROVISIONING_KEY: '',
				OIDC_ISSUER: 'https://idp.test',
				OIDC_CLIENT_ID: 'client',
				OIDC_CLIENT_SECRET: 'secret',
				OIDC_SCOPES: '',
				OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
			}, { waitUntil() {} }),
	}
}

/** Register a passkey for `principalId` through IAM's ceremony, as the console's Account → Passkeys page does. */
async function registerPasskey(transport: HttpService, token: string, authenticator: TestAuthenticator): Promise<PasskeyDto> {
	const rpc = async (method: string, input: unknown): Promise<unknown> => {
		const response = await transport.fetch(
			new Request(`${ISSUER}/admin/rpc`, {
				method: 'POST',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ method, input }),
			}),
		)
		const body: { result?: unknown } = await response.json()
		if (response.status !== 200) throw new Error(`${method}: ${response.status}`)
		return body.result
	}
	const issued = await rpc('passkeys.registrationOptions', null)
	if (!isCreation(issued)) throw new Error('no creation options')
	const credential = await authenticator.register(issued.options, CONSOLE)
	const passkey = await rpc('passkeys.register', { challengeId: issued.challengeId, label: 'Laptop', credential })
	if (typeof passkey !== 'object' || passkey === null || !('id' in passkey) || typeof passkey.id !== 'string') throw new Error('no passkey')
	return { id: passkey.id, label: 'Laptop', createdAt: 0, lastUsedAt: null }
}

function isCreation(value: unknown): value is PasskeyChallenge<PasskeyCreationOptions> {
	return typeof value === 'object' && value !== null && 'challengeId' in value && 'options' in value
}

async function setup() {
	const iam = createIamHarness()
	await iam.repositories.handoff.setReturnOrigins(CONSOLE_APP, [CONSOLE])
	const transport = iamTransport(iam.repositories)
	const ada = (await iam.repositories.principals.createUser('sub-ada', 'ada@example.test')).id
	const eve = (await iam.repositories.principals.createUser('sub-eve', 'eve@example.test')).id
	const authenticator = await TestAuthenticator.create()
	await registerPasskey(transport, await adminTokenFor(iam.repositories, ada, { issuer: ISSUER }), authenticator)

	const control = createHarness()
	const db: ControlRepositories = control.repositories
	await db.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes', defaultBranch: 'main' })
	await db.registry.upsertAppEnv({
		appId: 'notes',
		env: 'prod',
		namespaceId: null,
		provider: 'harbor',
		providerTargetJson: ENVELOPE,
		providerArtifactJson: ENVELOPE,
	})
	const locks = new SqlDeployLocks(harnessDatabase(db))

	/** A request for a credential, which takes a passkey to decide by default. */
	async function credentialRequest(): Promise<{ id: string; inputDigest: string }> {
		const inputJson = '{"name":"ci"}'
		const row = await db.approvalRequests.create({
			id: uuidv7(),
			kind: 'test.credentials.issue',
			inputJson,
			inputDigest: jsonDigest(inputJson),
			appId: 'notes',
			env: 'prod',
			category: 'credentials',
			requester: { id: 'svc-agent', type: 'service', label: 'agent', credential: 'key', clientId: null, grantId: null, issuerId: null },
			beforeJson: '{}',
			beforeDigest: jsonDigest('{}'),
			ttlSeconds: 3600,
		})
		return { id: row.id, inputDigest: row.input_digest }
	}

	const audited: DomainEvent[] = []

	/** A console call by `principalId`, carrying the token IAM signed for their signed-in session. */
	async function consoleCall(principalId: string) {
		const token = await adminTokenFor(iam.repositories, principalId, { issuer: ISSUER })
		const request = new Request(`${CONSOLE}/api/rpc`, { method: 'POST', headers: { 'X-Fabrika-Token': token, 'Sec-Fetch-Site': 'same-origin' } })
		const grants = [{ action: CONTROL_ACTIONS.ACCESS_APPROVE, scope: null, source: 'grant' as const }]
		const auth: AuthContext = {
			ok: true,
			principal: { id: principalId, type: 'user', label: principalId },
			can: (action, scope) => permits(grants, action, scope),
			scopedTo: () => null,
			audit: (event) => Promise.resolve(void audited.push(event)),
		}
		const stepUp = iamPasskeyStepUp(transport, request)
		return { request, auth, ...(stepUp === null ? {} : { stepUp }) }
	}

	async function context(principalId: string): Promise<ApprovalRequestContext> {
		const { request, ...call } = await consoleCall(principalId)
		return { repositories: db, admission: { request }, lock: locks, ...call }
	}

	/** The same console call, as `apps.environments.protect` and its challenge read it. */
	async function protection(principalId: string): Promise<ApprovalUseCaseContext> {
		return { repositories: db, queue: { send: () => Promise.resolve() }, lock: locks, ...await consoleCall(principalId) }
	}

	/** Answer a challenge Control obtained from IAM with ada's authenticator. */
	async function answer(issued: ApprovalStepUpChallenge): Promise<ApprovalStepUp> {
		if (issued.kind !== 'challenge') throw new Error('ada holds a passkey')
		return { challengeId: issued.challenge.challengeId, credential: await authenticator.assert(issued.challenge.options, CONSOLE) }
	}

	function close(): void {
		iam.sqlite.close()
		control.sqlite.close()
	}

	/** IAM forgets the console's origin, so no passkey can be bound to it. */
	async function forgetConsoleOrigin(): Promise<void> {
		await iam.repositories.handoff.setReturnOrigins(CONSOLE_APP, [])
	}

	return { db, ada, eve, authenticator, audited, credentialRequest, context, protection, answer, forgetConsoleOrigin, close }
}

const refusal = async (promise: Promise<unknown>): Promise<{ status: number; message: string }> => {
	try {
		await promise
		return { status: 200, message: '' }
	} catch (error) {
		if (error instanceof ControlApiError) return { status: error.httpStatus, message: error.message }
		throw error
	}
}

const status = async (promise: Promise<unknown>): Promise<number> => {
	try {
		await promise
		return 200
	} catch (error) {
		if (error instanceof ControlApiError) return error.httpStatus
		throw error
	}
}

describe('the step-up through the real IAM', () => {
	test("IAM verifies the approver's assertion bound to the decision; it decides that one item once, and no other", async () => {
		const s = await setup()
		try {
			const x = await s.credentialRequest()
			const y = await s.credentialRequest()
			const decide = { id: x.id, decision: 'reject' as const, inputDigest: x.inputDigest }
			const assertion = await s.answer(await challengeApprovalRequestUseCase(await s.context(s.ada), decide))

			expect(await status(decideApprovalRequestUseCase(await s.context(s.ada), { ...decide, id: y.id, inputDigest: y.inputDigest, stepUp: assertion })))
				.toBe(403)
			expect((await s.db.approvalRequests.get(y.id))?.state).toBe('pending')
			// IAM consumed the challenge on the refused use: the assertion is spent.
			expect(await status(decideApprovalRequestUseCase(await s.context(s.ada), { ...decide, stepUp: assertion }))).toBe(403)

			const fresh = await s.answer(await challengeApprovalRequestUseCase(await s.context(s.ada), decide))
			expect((await decideApprovalRequestUseCase(await s.context(s.ada), { ...decide, stepUp: fresh })).state).toBe('rejected')
			expect(await s.db.approvalRequests.get(x.id)).toMatchObject({
				decided_by_id: s.ada,
				decided_step_up_credential_id: s.authenticator.credentialId,
				decided_step_up_at: expect.any(Number),
			})
		} finally {
			s.close()
		}
	})

	test('a person without a passkey is told so by the challenge, and cannot decide', async () => {
		const s = await setup()
		try {
			const x = await s.credentialRequest()
			const decide = { id: x.id, decision: 'reject' as const, inputDigest: x.inputDigest }
			expect(await challengeApprovalRequestUseCase(await s.context(s.eve), decide)).toEqual({ kind: 'no-passkey' })
			expect(await status(decideApprovalRequestUseCase(await s.context(s.eve), decide))).toBe(403)
		} finally {
			s.close()
		}
	})

	test("Control tells IAM's refusals of a challenge apart: no passkey, too many open challenges, no console origin", async () => {
		const s = await setup()
		try {
			const x = await s.credentialRequest()
			const challenge = { id: x.id, decision: 'reject' as const, inputDigest: x.inputDigest }
			expect(await challengeApprovalRequestUseCase(await s.context(s.eve), challenge)).toEqual({ kind: 'no-passkey' })

			for (let open = 0; open < 10; open++) expect((await challengeApprovalRequestUseCase(await s.context(s.ada), challenge)).kind).toBe('challenge')
			expect(await refusal(challengeApprovalRequestUseCase(await s.context(s.ada), challenge))).toEqual({
				status: 429,
				message: 'too many open passkey challenges; try again in a few minutes',
			})

			await s.forgetConsoleOrigin()
			expect(await refusal(challengeApprovalRequestUseCase(await s.context(s.eve), challenge))).toEqual({
				status: 409,
				message: 'the console has no registered origin, so a passkey cannot be bound to it',
			})
		} finally {
			s.close()
		}
	})

	describe('a change of protection that weakens a passkey on deciding', () => {
		const PROD = { appId: 'notes', env: 'prod' }
		const noPasskey = { ...STRICT_SETTINGS, stepUp: { ...STRICT_SETTINGS.stepUp, credentials: 'none' as const } }
		const weaken: ProtectionChallengeInput = { ...PROD, protected: true, policy: STRICT_POLICY, settings: noPasskey }

		async function credentialsStepUp(db: ControlRepositories): Promise<string> {
			const row = await db.registry.getAppEnv('notes', 'prod')
			if (row === null) throw new Error('no prod')
			return appEnvSettings(row).stepUp.credentials
		}

		test('is refused without an assertion and writes nothing; with one bound to it, it is written and audited', async () => {
			const s = await setup()
			try {
				expect(await refusal(setEnvironmentProtectionUseCase(await s.protection(s.ada), weaken))).toEqual({
					status: 403,
					message: 'this change takes a passkey: confirm it with one of your passkeys',
				})
				expect(await credentialsStepUp(s.db)).toBe('webauthn')
				expect(s.audited).toEqual([])

				const stepUp = await s.answer(await challengeProtectionUseCase(await s.protection(s.ada), weaken))
				expect((await setEnvironmentProtectionUseCase(await s.protection(s.ada), { ...weaken, stepUp })).approvalSettings).toEqual(noPasskey)
				expect(await credentialsStepUp(s.db)).toBe('none')
				expect(s.audited).toMatchObject([
					{ action: 'access.protect', metadata: { stepUp: { credentialId: s.authenticator.credentialId, at: expect.any(Number) } } },
				])
			} finally {
				s.close()
			}
		})

		test("an assertion for one change applies no other change and decides no item; a decision's applies no change", async () => {
			const s = await setup()
			try {
				const unprotect = { ...PROD, protected: false }
				const forWeaken = await s.answer(await challengeProtectionUseCase(await s.protection(s.ada), weaken))
				expect((await refusal(setEnvironmentProtectionUseCase(await s.protection(s.ada), { ...unprotect, stepUp: forWeaken }))).status).toBe(403)

				const x = await s.credentialRequest()
				const decide = { id: x.id, decision: 'reject' as const, inputDigest: x.inputDigest }
				const another = await s.answer(await challengeProtectionUseCase(await s.protection(s.ada), weaken))
				expect(await status(decideApprovalRequestUseCase(await s.context(s.ada), { ...decide, stepUp: another }))).toBe(403)
				expect((await s.db.approvalRequests.get(x.id))?.state).toBe('pending')

				const forDecision = await s.answer(await challengeApprovalRequestUseCase(await s.context(s.ada), decide))
				expect((await refusal(setEnvironmentProtectionUseCase(await s.protection(s.ada), { ...weaken, stepUp: forDecision }))).status).toBe(403)
				expect((await s.db.registry.getAppEnv('notes', 'prod'))?.protected).toBe(1)
				expect(await credentialsStepUp(s.db)).toBe('webauthn')
			} finally {
				s.close()
			}
		})

		test('a tightening, and a change to categories without a passkey, take none; their challenge answers 409', async () => {
			const s = await setup()
			try {
				const tighten = {
					...PROD,
					protected: true,
					settings: { ...STRICT_SETTINGS, approvers: { ...STRICT_SETTINGS.approvers, credentials: 2 as const } },
				}
				expect(await refusal(challengeProtectionUseCase(await s.protection(s.ada), tighten))).toEqual({
					status: 409,
					message: 'this change takes no passkey',
				})
				await setEnvironmentProtectionUseCase(await s.protection(s.ada), tighten)
				const elsewhere = { ...PROD, protected: true, policy: { ...STRICT_POLICY, 'deletes-data': 'off' as const, secrets: 'off' as const } }
				expect((await setEnvironmentProtectionUseCase(await s.protection(s.ada), elsewhere)).approvalPolicy).toEqual(elsewhere.policy)
			} finally {
				s.close()
			}
		})

		test('unprotecting an environment whose credentials take a passkey by default takes one', async () => {
			const s = await setup()
			try {
				const unprotect = { ...PROD, protected: false }
				expect((await refusal(setEnvironmentProtectionUseCase(await s.protection(s.ada), unprotect))).status).toBe(403)
				expect((await s.db.registry.getAppEnv('notes', 'prod'))?.protected).toBe(1)
				// A person with no passkey is told so by the challenge.
				expect(await challengeProtectionUseCase(await s.protection(s.eve), unprotect)).toEqual({ kind: 'no-passkey' })

				const stepUp = await s.answer(await challengeProtectionUseCase(await s.protection(s.ada), unprotect))
				expect((await setEnvironmentProtectionUseCase(await s.protection(s.ada), { ...unprotect, stepUp })).protected).toBe(false)
				// Unprotected, loosening anything takes none.
				const loosen = {
					...PROD,
					protected: false,
					settings: { ...STRICT_SETTINGS, stepUp: { ...STRICT_SETTINGS.stepUp, credentials: 'none' as const } },
				}
				expect((await setEnvironmentProtectionUseCase(await s.protection(s.ada), loosen)).approvalSettings.stepUp.credentials).toBe('none')
			} finally {
				s.close()
			}
		})

		test('an unprotected environment decides under the defaults, so protecting it without their passkey takes one', async () => {
			const s = await setup()
			try {
				const unprotect = { ...PROD, protected: false }
				const stepUp = await s.answer(await challengeProtectionUseCase(await s.protection(s.ada), unprotect))
				await setEnvironmentProtectionUseCase(await s.protection(s.ada), { ...unprotect, stepUp })
				const x = await s.credentialRequest()
				const decide = { id: x.id, decision: 'reject' as const, inputDigest: x.inputDigest }
				expect(await status(decideApprovalRequestUseCase(await s.context(s.ada), decide))).toBe(403)

				expect((await refusal(setEnvironmentProtectionUseCase(await s.protection(s.ada), weaken))).status).toBe(403)
				expect((await s.db.registry.getAppEnv('notes', 'prod'))?.protected).toBe(0)
				expect(await status(decideApprovalRequestUseCase(await s.context(s.ada), decide))).toBe(403)
				expect((await s.db.approvalRequests.get(x.id))?.state).toBe('pending')
			} finally {
				s.close()
			}
		})
	})
})
