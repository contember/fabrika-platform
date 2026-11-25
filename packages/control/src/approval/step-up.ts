// The step-up on deciding a pending item (ADR-0050 §5): a passkey assertion bound to the decision. Control builds the
// binding from the item it decides, IAM issues the challenge and verifies the answer, each with the approver's own console
// token, and Control decides only when IAM verified an assertion of that approver against that binding.

import { createRpcClient, RpcError } from '@fabrika/app'
import { PROXY_TOKEN_HEADER } from '@fabrika/auth'
import type { ApprovalDecision, ApprovalStepUp, ApprovalStepUpChallenge, StepUpMode } from '@fabrika/control-contract'
import type { IamAdminRpcContract, PasskeyChallenge, PasskeyRequestOptions, VerifiedPasskeyAssertion } from '@fabrika/iam-contract'
import type { HttpService } from '@fabrika/platform'
import { z } from 'zod'
import { fail } from '../api/domain'

/** What a decision records of its step-up: the passkey that answered (its WebAuthn id) and when IAM verified it. */
export interface StepUpRecord {
	readonly credentialId: string
	readonly at: number
}

/** The binding of a parked run's decision: the run, the decision and the two digests it approves or refuses. */
export function runStepUpBinding(runId: string, decision: ApprovalDecision, candidateDigest: string, baselineDigest: string): string {
	return `control:approval:${JSON.stringify(['run', runId, decision, candidateDigest, baselineDigest])}`
}

/** The binding of an approval request's decision: the request, the decision and the input digest it decides. */
export function requestStepUpBinding(id: string, decision: ApprovalDecision, inputDigest: string): string {
	return `control:approval:${JSON.stringify(['request', id, decision, inputDigest])}`
}

/**
 * IAM's passkey step-up for the person the request's console token names. `challenge` answers null when the person has
 * no passkey; `verify` answers null when IAM refused the assertion. Every other failure throws.
 */
export interface PasskeyStepUpPort {
	challenge(binding: string): Promise<PasskeyChallenge<PasskeyRequestOptions> | null>
	verify(binding: string, assertion: ApprovalStepUp): Promise<VerifiedPasskeyAssertion | null>
}

const base64url = z.string().min(1).max(16_384).regex(/^[A-Za-z0-9_-]+$/)

/** The assertion a decision carries, checked at the edge; IAM checks it again. */
export const stepUpAssertionSchema = z.object({
	challengeId: z.string().min(1).max(64),
	credential: z.object({
		id: base64url,
		rawId: base64url,
		type: z.literal('public-key'),
		response: z.object({ clientDataJSON: base64url, authenticatorData: base64url, signature: base64url, userHandle: base64url.optional() }).strict(),
	}).strict(),
}).strict()

const descriptorSchema = z.object({ type: z.literal('public-key'), id: z.string(), transports: z.array(z.string()).optional() })

const challengeSchema = z.object({
	challengeId: z.string().min(1),
	expiresAt: z.number().int(),
	options: z.object({
		challenge: z.string().min(1),
		rpId: z.string().min(1),
		timeout: z.number().int(),
		allowCredentials: z.array(descriptorSchema),
		userVerification: z.literal('required'),
	}),
})

const verifiedSchema = z.object({ principalId: z.string().min(1), credentialId: z.string().min(1), at: z.number().int() })

/** The status of IAM's refusal; null for a transport failure, a server error or an answer that did not parse. */
function refusalStatus(cause: unknown): number | null {
	if (!(cause instanceof RpcError) || cause.httpStatus === undefined) return null
	return cause.httpStatus >= 400 && cause.httpStatus < 500 ? cause.httpStatus : null
}

/**
 * The port over IAM's admin RPC, through the same transport the console's IAM gateway uses (`IAM_ADMIN`), with the
 * approver's console token as the bearer, the one the proxy injected and Control verified. Null without that token.
 */
export function iamPasskeyStepUp(gateway: HttpService, request: Request): PasskeyStepUpPort | null {
	const token = request.headers.get(PROXY_TOKEN_HEADER)?.trim() ?? ''
	if (token === '') return null
	const client = createRpcClient<IamAdminRpcContract>({
		baseUrl: new URL('/admin/rpc', request.url).toString(),
		bounceOnAuth: false,
		fetch: (input, init) => {
			const headers = new Headers(init?.headers)
			headers.set('authorization', `Bearer ${token}`)
			// The token must never reach a redirect target; the client reads a 3xx as a failed call.
			return gateway.fetch(new Request(input, { method: init?.method ?? 'POST', headers, body: init?.body ?? null, redirect: 'manual' }))
		},
	})
	return {
		async challenge(binding) {
			try {
				return challengeSchema.parse(await client.passkeys.challenge({ binding }))
			} catch (cause) {
				// IAM answers 409 to a person with no passkey to answer the challenge with.
				if (refusalStatus(cause) === 409) return null
				throw cause
			}
		},
		async verify(binding, assertion) {
			try {
				return verifiedSchema.parse(await client.passkeys.verify({ binding, assertion }))
			} catch (cause) {
				if (refusalStatus(cause) !== null) return null
				throw cause
			}
		},
	}
}

/** Ask IAM for a challenge bound to one decision, for the page to answer before it posts the decision. */
export async function issueStepUpChallenge(port: PasskeyStepUpPort | undefined, binding: string): Promise<ApprovalStepUpChallenge> {
	if (port === undefined) fail(503, 'Control cannot reach IAM to issue a passkey challenge; nothing can be decided that takes one')
	let challenge: PasskeyChallenge<PasskeyRequestOptions> | null
	try {
		challenge = await port.challenge(binding)
	} catch {
		fail(502, 'IAM did not issue a passkey challenge; try again')
	}
	return challenge === null ? { kind: 'no-passkey' } : { kind: 'challenge', challenge }
}

/**
 * The step-up a decision takes, checked before anything is written: none under `none`; under `webauthn` an assertion
 * IAM verifies against `binding`, the one Control built from the item it decides, made by the approver. A missing
 * assertion, a refusal, a failure to reach IAM and another person's assertion all refuse the decision.
 */
export async function requireStepUp(
	port: PasskeyStepUpPort | undefined,
	mode: StepUpMode,
	binding: string,
	approver: { readonly id: string },
	assertion: ApprovalStepUp | undefined,
): Promise<StepUpRecord | null> {
	if (mode === 'none') return null
	if (assertion === undefined) fail(403, 'this decision takes a passkey: confirm it with one of your passkeys')
	let verified: VerifiedPasskeyAssertion | null = null
	try {
		verified = port === undefined ? null : await port.verify(binding, assertion)
	} catch {
		verified = null
	}
	if (verified === null || verified.principalId !== approver.id) fail(403, 'the passkey check failed, so nothing was decided; try again')
	return { credentialId: verified.credentialId, at: verified.at }
}
