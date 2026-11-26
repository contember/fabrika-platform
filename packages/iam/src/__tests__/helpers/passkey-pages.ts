// A person's passkey ceremonies as IAM's own pages run them, for suites that need a registered passkey or an answered
// step-up without driving the HTML (`passkeys.test.ts` drives the pages themselves).

import type { IamRepositories } from '../../db'
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
