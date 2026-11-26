// A person's passkey ceremonies as IAM's own pages run them, for suites that need a registered passkey or an answered
// step-up without driving the HTML (`passkeys.test.ts` drives the pages themselves), and the reader of a ceremony page.

import type { PasskeyRequestOptions } from '@fabrika/iam-contract'
import type { IamRepositories } from '../../db'
import { prop } from '../../json'
import { answerStepUp, completeRegistration, issueRegistrationChallenge, openStepUp, relyingParty } from '../../passkeys'
import { makeServicesFor } from './harness'
import type { TestAuthenticator } from './webauthn'

/** Register `authenticator` as the first passkey of `principalId`, at the IAM whose issuer is `issuer`. */
export async function registerTestPasskey(
	repositories: IamRepositories,
	issuer: string,
	principalId: string,
	authenticator: TestAuthenticator,
): Promise<void> {
	const services = makeServicesFor(repositories, { issuer })
	const rp = relyingParty(services.config)
	const principal = await repositories.principals.getPrincipalById(principalId)
	if (principal === null) throw new Error(`no principal ${principalId}`)
	const issued = await issueRegistrationChallenge(services, rp, principal, false)
	if (issued === null) throw new Error('no registration challenge')
	const registered = await completeRegistration(
		services,
		rp,
		principalId,
		{ challengeId: issued.challengeId, label: 'Laptop', credential: await authenticator.register(issued.options, rp.origin) },
		(passkeyId) => ({
			requestId: 'test',
			principalId,
			principalLabel: principal.label,
			app: 'iam',
			action: 'iam.passkey.register',
			resourceType: 'principal',
			resourceId: principalId,
			metadata: { passkeyId },
		}),
	)
	if (!registered.ok) throw new Error(`registration refused: ${registered.reason}`)
}

/** Answer the step-up challenge `challengeId` of `principalId` with `authenticator`, as the step-up page does. */
export async function answerTestStepUp(
	repositories: IamRepositories,
	issuer: string,
	principalId: string,
	authenticator: TestAuthenticator,
	challengeId: string,
): Promise<void> {
	const services = makeServicesFor(repositories, { issuer })
	const rp = relyingParty(services.config)
	const open = await openStepUp(services, rp, principalId, challengeId)
	if (open === null) throw new Error('no open step-up challenge')
	const answered = await answerStepUp(services, rp, principalId, { challengeId, credential: await authenticator.assert(open.options, rp.origin) })
	if (!answered.ok) throw new Error(`step-up refused: ${answered.reason}`)
}

function unescapeHtml(value: string): string {
	return value.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
}

/** A ceremony page: which ceremony, its options and the hidden fields its form posts. */
export interface Ceremony {
	readonly ceremony: string
	readonly options: unknown
	readonly fields: Record<string, string>
}

export async function ceremonyOf(response: Response): Promise<Ceremony> {
	const html = await response.text()
	const form = /<form id="webauthn"[^>]*data-ceremony="(get|create)" data-options="([^"]*)"/.exec(html)
	if (response.status !== 200 || form === null) throw new Error(`expected a ceremony page, got ${response.status} ${html.slice(0, 400)}`)
	const fields = Object.fromEntries(
		[...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((
			match,
		) => [unescapeHtml(match[1] ?? ''), unescapeHtml(match[2] ?? '')]),
	)
	return { ceremony: form[1] ?? '', options: JSON.parse(unescapeHtml(form[2] ?? '')), fields }
}

/** The request options of an assertion ceremony page. */
export function assertionOptionsOf(page: Ceremony): PasskeyRequestOptions {
	const options = page.options
	if (page.ceremony !== 'get' || !isRequestOptions(options)) throw new Error('expected an assertion ceremony')
	return options
}

function isRequestOptions(value: unknown): value is PasskeyRequestOptions {
	return typeof prop(value, 'rpId') === 'string' && typeof prop(value, 'challenge') === 'string'
}
