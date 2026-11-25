// The step-up on deciding a pending item (ADR-0050 §5), in the console: when deciding takes a passkey, the prompt runs
// on a challenge for this one decision before the decision is posted, and carries its answer; a person with no passkey
// is told so and where to register one. The browser is a stand-in that records what it was asked.

import { buildRouteTree, createMemoryNavigationAdapter, Router } from '@buzola/router'
import { BuzolaProvider } from '@buzola/router/react'
import type { ApprovalStepUp, ApprovalStepUpChallenge } from '@fabrika/control-contract'
import type { PasskeyRequestOptions } from '@fabrika/iam-contract'
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DecisionFailureNotice } from '../components/DecisionFailureNotice'
import { decisionFailure, NoPasskeyError, postDecision } from '../lib/decision-step-up'
import { type PasskeyCredentials, toBase64Url } from '../lib/webauthn'

const bytes = (...values: number[]) => Uint8Array.from(values).buffer

const OPTIONS: PasskeyRequestOptions = {
	challenge: toBase64Url(bytes(4, 5, 6)),
	rpId: 'console.example.test',
	timeout: 300_000,
	allowCredentials: [{ type: 'public-key', id: toBase64Url(bytes(7, 7)) }],
	userVerification: 'required',
}

const ASSERTED = {
	type: 'public-key',
	rawId: bytes(0xfb, 0xff),
	response: { clientDataJSON: bytes(1), authenticatorData: bytes(2), signature: bytes(3), userHandle: null },
}

/** A browser, a challenge and a decision that record, in order, what each was asked. */
function flow(options: { issued?: ApprovalStepUpChallenge; get?: () => Promise<unknown> } = {}) {
	const steps: string[] = []
	const posted: (ApprovalStepUp | undefined)[] = []
	const credentials: PasskeyCredentials = {
		create: () => Promise.reject(new Error('not asked')),
		get: () => {
			steps.push('passkey')
			return options.get?.() ?? Promise.resolve(ASSERTED)
		},
	}
	const challenge = () => {
		steps.push('challenge')
		return Promise.resolve(options.issued ?? { kind: 'challenge', challenge: { challengeId: 'challenge-1', expiresAt: 0, options: OPTIONS } })
	}
	const post = (stepUp: ApprovalStepUp | undefined) => {
		steps.push('decision')
		posted.push(stepUp)
		return Promise.resolve()
	}
	return { steps, posted, credentials, challenge, post }
}

describe('the decision', () => {
	test('under webauthn the prompt runs first, on a challenge for this decision, and the decision carries its answer', async () => {
		const f = flow()
		await postDecision('webauthn', f.credentials, f.challenge, f.post)
		expect(f.steps).toEqual(['challenge', 'passkey', 'decision'])
		expect(f.posted[0]?.challengeId).toBe('challenge-1')
		expect(f.posted[0]?.credential).toMatchObject({ id: '-_8', type: 'public-key' })
	})

	test('under none it is posted as it is, with no prompt', async () => {
		const f = flow()
		await postDecision('none', f.credentials, f.challenge, f.post)
		expect(f.steps).toEqual(['decision'])
		expect(f.posted).toEqual([undefined])
	})

	test('a person without a passkey is told so and where to register one, and nothing is posted', async () => {
		const f = flow({ issued: { kind: 'no-passkey' } })
		const cause = await postDecision('webauthn', f.credentials, f.challenge, f.post).catch((error: unknown) => error)
		expect(cause).toBeInstanceOf(NoPasskeyError)
		expect(f.steps).toEqual(['challenge'])
		const failure = decisionFailure(cause)
		expect(failure.noPasskey).toBe(true)
		const router = new Router({
			routes: buildRouteTree([{ path: '/', component: () => null, isIndex: true }]),
			adapter: createMemoryNavigationAdapter(),
			pageRegistry: { 'account/passkeys': '/account/passkeys' },
		})
		const markup = renderToStaticMarkup(createElement(BuzolaProvider, { router }, createElement(DecisionFailureNotice, { failure })))
		expect(markup).toContain('role="alert"')
		expect(markup).toContain('You have no passkey, and this decision takes one.')
		expect(markup).toContain('<a href="/account/passkeys">Account → Passkeys</a>')
	})

	test('a cancelled prompt, or a browser without passkeys, posts nothing and says why', async () => {
		const cancelled = flow({ get: () => Promise.reject(new DOMException('cancelled', 'NotAllowedError')) })
		const cause = await postDecision('webauthn', cancelled.credentials, cancelled.challenge, cancelled.post).catch((error: unknown) => error)
		expect(decisionFailure(cause)).toEqual({ message: 'The passkey prompt was cancelled or timed out. Try again.', noPasskey: false })
		expect(cancelled.posted).toEqual([])

		const none = flow()
		const unsupported = await postDecision('webauthn', null, none.challenge, none.post).catch((error: unknown) => error)
		expect(decisionFailure(unsupported).message).toBe('This browser cannot use passkeys, so this decision cannot be confirmed here.')
		expect(none.steps).toEqual([])
	})
})
