// What no approval request may name (ADR-0083 §9): it is refused when the request is created, never at approval. A kind
// is named after the procedure it stands for: Control's own, or IAM's administration RPC under `iam.`.

const ALWAYS_A_PERSON = 'it always takes a person in the console, whatever the mode'
const CONFIGURATION = `the approval configuration (the flag, the modes, the settings): ${ALWAYS_A_PERSON}`
const DECIDING = `deciding a pending item: ${ALWAYS_A_PERSON}`
const PROTECTED_DELETE = `deleting a protected environment, or an application with one: ${ALWAYS_A_PERSON}`
const SOURCE = 'source connections are a browser flow with GitHub, which a person completes'
const PAIRING = 'builder pairing is a browser flow, which a person completes'
const INSTALLATION = "installation administration in IAM keeps its own rule: a person's session, or a key a person gave `iam.admin`"
const FREES_RESOURCES = 'it frees resources the next application could adopt with their old secrets (ADR-0034), so it keeps its own rule'
const CONTENT = "an approval would deliver the environment's data content to the agent"
const RETURNS_SECRET = 'it would return a secret to the agent in a form Control could read'

const REFUSED: Readonly<Record<string, string>> = {
	'apps.environments.protect': CONFIGURATION,
	'apps.environments.protectChallenge': CONFIGURATION,
	'iam.grantApproval.set': CONFIGURATION,
	'approvals.complete': DECIDING,
	'approvals.requests.decide': DECIDING,
	'approvals.challenge': DECIDING,
	'approvals.requests.challenge': DECIDING,
	'iam.grantRequests.decide': DECIDING,
	'apps.environments.delete': PROTECTED_DELETE,
	'apps.delete': PROTECTED_DELETE,
	'sourceConnection.start': SOURCE,
	'sourceConnection.handoff': SOURCE,
	'sourceConnection.cancel': SOURCE,
	'sourceConnection.verifyInstallation': SOURCE,
	'sourceConnection.repair': SOURCE,
	'sourceConnection.reconcile': SOURCE,
	'builderPairing.approve': PAIRING,
	'builderPairing.deny': PAIRING,
	'builderConnections.createReceipt': PAIRING,
	'iam.principals.invite': INSTALLATION,
	'iam.principals.update': INSTALLATION,
	'iam.principals.promote': INSTALLATION,
	'iam.passwords.issueEnrollment': INSTALLATION,
	'iam.passwords.issueReset': INSTALLATION,
	'iam.apps.setReturnOrigins': INSTALLATION,
	'iam.policies.create': INSTALLATION,
	'iam.policies.update': INSTALLATION,
	'iam.policies.delete': INSTALLATION,
	'iam.terminals.setProfile': INSTALLATION,
	'iam.brand.set': INSTALLATION,
	'iam.brand.clear': INSTALLATION,
	'iam.passwordPolicy.set': INSTALLATION,
	'iam.secondFactor.reset': INSTALLATION,
	'namespaces.remove': FREES_RESOURCES,
	'namespaces.releaseClaims': FREES_RESOURCES,
	'data.content': CONTENT,
	'iam.workloads.issueKey': RETURNS_SECRET,
	'iam.membershipKeys.issue': RETURNS_SECRET,
	'iam.shareLinks.issue': RETURNS_SECRET,
}

/** Why no request may name `kind`, or null when it is not on the refused list. */
export function refusedKindReason(kind: string): string | null {
	return Object.hasOwn(REFUSED, kind) ? (REFUSED[kind] ?? null) : null
}

/** Every kind on the refused list, for the tests that keep it in step with the routers. */
export const REFUSED_KINDS: readonly string[] = Object.keys(REFUSED)
