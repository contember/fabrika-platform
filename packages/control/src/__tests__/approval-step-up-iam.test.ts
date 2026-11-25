// ADR-0050 §5 end to end: deciding an approval request that takes a step-up, with Control's real IAM client over IAM's
// admin transport (`IAM_ADMIN`), answered by IAM's own app in process with its real WebAuthn verifier. The authenticator
// is IAM's test one, a WebCrypto key pair; the approver's console token is one IAM signed for a signed-in session.

import type { AuthContext } from '@fabrika/auth'
import { permits } from '@fabrika/auth-core'
import { type ApprovalStepUp, type ApprovalStepUpChallenge, CONTROL_ACTIONS } from '@fabrika/control-contract'
import type { PasskeyChallenge, PasskeyCreationOptions, PasskeyDto } from '@fabrika/iam-contract'
import { type HttpService, SqlDeployLocks, uuidv7 } from '@fabrika/platform'
import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import { adminTokenFor, CONSOLE_APP, createHarness as createIamHarness, TEST_SIGNING_KEYS } from '../../../iam/src/__tests__/helpers/harness'
import { TestAuthenticator } from '../../../iam/src/__tests__/helpers/webauthn'
import { createIamApp } from '../../../iam/src/app'
import type { IamRepositories } from '../../../iam/src/db'
import { ControlApiError } from '../api/domain'
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

	/** A console call by `principalId`, carrying the token IAM signed for their signed-in session. */
	async function context(principalId: string): Promise<ApprovalRequestContext> {
		const token = await adminTokenFor(iam.repositories, principalId, { issuer: ISSUER })
		const request = new Request(`${CONSOLE}/api/rpc`, { method: 'POST', headers: { 'X-Fabrika-Token': token, 'Sec-Fetch-Site': 'same-origin' } })
		const grants = [{ action: CONTROL_ACTIONS.ACCESS_APPROVE, scope: null, source: 'grant' as const }]
		const auth: AuthContext = {
			ok: true,
			principal: { id: principalId, type: 'user', label: principalId },
			can: (action, scope) => permits(grants, action, scope),
			scopedTo: () => null,
			audit: () => Promise.resolve(),
		}
		const stepUp = iamPasskeyStepUp(transport, request)
		return { repositories: db, auth, admission: { request }, lock: locks, ...(stepUp === null ? {} : { stepUp }) }
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

	return { db, ada, eve, authenticator, credentialRequest, context, answer, close }
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
})
