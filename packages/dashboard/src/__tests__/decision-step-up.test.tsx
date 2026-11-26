// The step-up on deciding a pending item (ADR-0050 §5), in the console: when deciding takes a passkey, the page fetches a
// challenge for this one decision and posts nothing until the person continues from IAM's step-up page; the decision then
// carries the challenge's id and nothing else. A person with no passkey is told so and where to add one.

import { buildRouteTree, createMemoryNavigationAdapter, Router } from '@buzola/router'
import { BuzolaProvider } from '@buzola/router/react'
import { RpcError } from '@fabrika/app'
import type { ApprovalStepUp, ApprovalStepUpChallenge } from '@fabrika/control-contract'
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DecisionFailureNotice } from '../components/DecisionFailureNotice'
import { PasskeyCheckFailure, PasskeyCheckPrompt } from '../components/PasskeyCheckPrompt'
import { decisionFailure, NoPasskeyError, startDecision } from '../lib/decision-step-up'

const URL_OF_CHECK = 'https://iam.example.test/auth/step-up?challenge=challenge-1'

/** A challenge and a decision that record, in order, what each was asked; `refuse` makes Control refuse the decision. */
function flow(options: { issued?: ApprovalStepUpChallenge; refuse?: boolean } = {}) {
	const steps: string[] = []
	const posted: (ApprovalStepUp | undefined)[] = []
	const challenge = () => {
		steps.push('challenge')
		return Promise.resolve(
			options.issued ?? { kind: 'challenge', challenge: { challengeId: 'challenge-1', expiresAt: 1_700_000_000, url: URL_OF_CHECK } },
		)
	}
	const post = (stepUp: ApprovalStepUp | undefined) => {
		steps.push('decision')
		posted.push(stepUp)
		if (options.refuse === true) {
			return Promise.reject(new RpcError({ type: 'forbidden', message: 'the passkey check failed, so nothing was decided; try again', httpStatus: 403 }))
		}
		return Promise.resolve('recorded')
	}
	return { steps, posted, challenge, post }
}

describe('the decision', () => {
	test('under none it is posted at once, with no challenge', async () => {
		const f = flow()
		expect(await startDecision('none', f.challenge, f.post, 'decision')).toEqual({ kind: 'posted', value: 'recorded' })
		expect(f.steps).toEqual(['decision'])
		expect(f.posted).toEqual([undefined])
	})

	test("under webauthn nothing is posted until the person continues from IAM's page, and then only the challenge's id", async () => {
		const f = flow()
		const started = await startDecision('webauthn', f.challenge, f.post, 'decision')
		expect(f.steps).toEqual(['challenge'])
		if (started.kind !== 'confirm') throw new Error('expected a passkey check')
		expect(started.check.url).toBe(URL_OF_CHECK)
		expect(started.check.expiresAt).toBe(1_700_000_000)

		expect(await started.check.post()).toBe('recorded')
		expect(f.steps).toEqual(['challenge', 'decision'])
		expect(f.posted).toEqual([{ challengeId: 'challenge-1' }])
	})

	test("a decision Control refuses, because the check was not answered, says so in Control's words and was posted once", async () => {
		const f = flow({ refuse: true })
		const started = await startDecision('webauthn', f.challenge, f.post, 'decision')
		if (started.kind !== 'confirm') throw new Error('expected a passkey check')
		const cause = await started.check.post().catch((error: unknown) => error)
		expect(decisionFailure(cause)).toEqual({ message: 'the passkey check failed, so nothing was decided; try again', noPasskey: false })
		expect(f.posted).toEqual([{ challengeId: 'challenge-1' }])
	})

	test('a person without a passkey is told so and where to add one, and nothing is posted', async () => {
		const f = flow({ issued: { kind: 'no-passkey' } })
		const cause = await startDecision('webauthn', f.challenge, f.post, 'decision').catch((error: unknown) => error)
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
		expect(markup).toContain('You have no passkey, and this decision takes one. Add one on your IAM account page, then decide.')
		expect(markup).toContain('<a href="/account/passkeys">Account → Passkeys</a>')
	})
})

describe('the passkey check', () => {
	test("links to IAM's step-up page in a new tab, without an opener, beside Continue and Cancel", () => {
		const check = { url: URL_OF_CHECK, expiresAt: 0, what: 'change' as const, post: () => Promise.reject(new Error('not continued')) }
		const markup = renderToStaticMarkup(<PasskeyCheckPrompt check={check} onDone={() => {}} onCancel={() => {}} />)
		expect(markup).toContain('Confirm this change with one of your passkeys on IAM&#x27;s page, then come back and continue.')
		expect(markup).toContain(`<a href="${URL_OF_CHECK}" target="_blank" rel="noopener noreferrer">Open the passkey check</a>`)
		expect(markup).toContain('>Continue</button>')
		expect(markup).toContain('>Cancel</button>')
		expect(markup).not.toContain('role="alert"')
	})

	test('a failed Continue says why, and that a confirmed check is started again, not continued', () => {
		const failure = decisionFailure(new RpcError({ type: 'conflict', message: 'the request was decided already', httpStatus: 409 }))
		const markup = renderToStaticMarkup(<PasskeyCheckFailure failure={failure} />)
		expect(markup).toContain('role="alert"')
		expect(markup).toContain('the request was decided already')
		expect(markup).toContain('A passkey check works once. If you confirmed it already, cancel and start again.')
	})
})
