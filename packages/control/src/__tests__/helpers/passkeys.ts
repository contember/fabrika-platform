// A stand-in for IAM's passkey step-up behind Control's IAM transport (`IAM_ADMIN`): it answers `passkeys.challenge` and
// `passkeys.verify` over `/admin/rpc` the way IAM does (a challenge is single-use, consumed before any comparison, and
// bound to its binding; a person with no passkey gets a 409 of type `no_passkey`), so Control's real client and error
// mapping run. Unlike IAM, it verifies an assertion whoever calls, so a test can show that Control itself refuses another
// person's assertion. The console token is `token:<principal id>`.

import { PROXY_TOKEN_HEADER } from '@fabrika/auth'
import {
	type AppEnvDto,
	type ApprovalStepUp,
	type ApprovalStepUpChallenge,
	type ProtectionChallengeInput,
	weakensStepUp,
} from '@fabrika/control-contract'
import { NO_PASSKEY_ERROR } from '@fabrika/iam-contract'
import type { HttpService } from '@fabrika/platform'
import { z } from 'zod'
import { type ApprovalUseCaseContext, challengeProtectionUseCase, setEnvironmentProtectionUseCase } from '../../approval/api'
import { appEnvPolicy, appEnvSettings } from '../../approval/categories'

interface IssuedChallenge {
	readonly binding: string
	readonly principalId: string
	used: boolean
}

export interface FakePasskeyIam {
	readonly gateway: HttpService
	/** The people who hold a passkey; anyone else gets a 409 from `passkeys.challenge`. */
	readonly people: Set<string>
	/** Every binding a challenge was issued for, in order. */
	readonly bindings: string[]
	/** How many verifications IAM was asked for. */
	verifications: number
}

const call = z.object({ method: z.string(), input: z.unknown() })
const challengeInput = z.object({ binding: z.string() })
const verifyInput = z.object({ binding: z.string(), assertion: z.object({ challengeId: z.string(), credential: z.object({ id: z.string() }) }) })

function answer(status: number, body: unknown): Response {
	return Response.json(body, { status })
}

function refusal(status: number, message: string): Response {
	return answer(status, { error: { type: status === 409 ? 'conflict' : 'forbidden', message } })
}

export function fakePasskeyIam(people: readonly string[] = []): FakePasskeyIam {
	const challenges = new Map<string, IssuedChallenge>()
	const iam: FakePasskeyIam = {
		people: new Set(people),
		bindings: [],
		verifications: 0,
		gateway: {
			async fetch(request) {
				if (new URL(request.url).pathname !== '/admin/rpc' || request.redirect !== 'manual') return refusal(400, 'not the admin RPC')
				const bearer = request.headers.get('authorization') ?? ''
				const principalId = bearer.startsWith('Bearer token:') ? bearer.slice('Bearer token:'.length) : null
				if (principalId === null) return answer(401, { error: { type: 'auth', message: 'authentication required' } })
				const { method, input } = call.parse(await request.json())
				if (method === 'passkeys.challenge') {
					const { binding } = challengeInput.parse(input)
					if (!iam.people.has(principalId)) {
						return answer(409, { error: { type: NO_PASSKEY_ERROR, message: 'no passkey is registered; register one under Account → Passkeys' } })
					}
					const challengeId = crypto.randomUUID()
					challenges.set(challengeId, { binding, principalId, used: false })
					iam.bindings.push(binding)
					return answer(200, {
						result: {
							challengeId,
							expiresAt: Math.floor(Date.now() / 1000) + 300,
							options: {
								challenge: 'Y2hhbGxlbmdl',
								rpId: 'console.example.test',
								timeout: 300_000,
								allowCredentials: [{ type: 'public-key', id: `cred-${principalId}` }],
								userVerification: 'required',
							},
						},
					})
				}
				if (method === 'passkeys.verify') {
					iam.verifications += 1
					const { binding, assertion } = verifyInput.parse(input)
					const issued = challenges.get(assertion.challengeId)
					if (issued === undefined || issued.used) return refusal(409, 'the passkey challenge expired or was already answered; ask for a new one')
					issued.used = true
					if (issued.binding !== binding) return refusal(403, 'the passkey challenge was issued for something else')
					return answer(200, { result: { principalId: issued.principalId, credentialId: assertion.credential.id, at: Math.floor(Date.now() / 1000) } })
				}
				return refusal(400, `unknown method ${method}`)
			},
		},
	}
	return iam
}

/** The headers of a console call by `principalId`: the proxy's injected token, no bearer. */
export function consoleTokenHeaders(principalId: string): Record<string, string> {
	return { [PROXY_TOKEN_HEADER]: `token:${principalId}` }
}

/** What the browser answers to an issued challenge with the passkey `cred-<principal>`. */
export function answerChallenge(issued: ApprovalStepUpChallenge, principalId: string): ApprovalStepUp {
	if (issued.kind !== 'challenge') throw new Error('the person has no passkey')
	const id = `cred-${principalId}`
	return {
		challengeId: issued.challenge.challengeId,
		credential: { id, rawId: id, type: 'public-key', response: { clientDataJSON: 'AA', authenticatorData: 'AA', signature: 'AA' } },
	}
}

/**
 * A change of protection as the console makes it (ADR-0050 §5): confirmed with `principalId`'s passkey when it weakens a
 * passkey on deciding under what the environment holds, posted as it is otherwise.
 */
export async function protectAsConsole(c: ApprovalUseCaseContext, input: ProtectionChallengeInput, principalId: string): Promise<AppEnvDto> {
	const held = await c.repositories.registry.getAppEnv(input.appId, input.env)
	if (held === null) return setEnvironmentProtectionUseCase(c, input)
	const before = { protected: held.protected === 1, policy: appEnvPolicy(held), settings: appEnvSettings(held) }
	const after = { protected: input.protected, policy: input.policy ?? before.policy, settings: input.settings ?? before.settings }
	if (weakensStepUp(before, after).length === 0) return setEnvironmentProtectionUseCase(c, input)
	const stepUp = answerChallenge(await challengeProtectionUseCase(c, input), principalId)
	return setEnvironmentProtectionUseCase(c, { ...input, stepUp })
}
