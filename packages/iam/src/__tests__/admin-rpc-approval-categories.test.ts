// Every mutation of IAM's `/admin/rpc` is judged by an approval category, or is exempt with its reason (ADR-0083 §9).
// `grants` gates a person's console grant (ADR-0083 §4), `credentials` IAM's own key issuance for a machine caller
// (ADR-0083 §8). A mutation added fails here until its author decides which.

import type { PolicyCategory } from '@fabrika/control-contract'
import { describe, expect, test } from 'bun:test'
import { adminRpcRouter } from '../admin/rpc'
import { routerLeaves } from './helpers/admin-router'

type Judged = { readonly category: PolicyCategory } | { readonly exempt: string }

const ALWAYS_A_PERSON = 'always a person, whatever the mode (ADR-0083 §9)'
const NARROWS = 'takes access away; nothing to approve'
const INSTALLATION = 'installation administration keeps its rule (ADR-0083 §9)'

const IAM: Readonly<Record<string, Judged>> = {
	'principals.invite': { exempt: INSTALLATION },
	'principals.update': { exempt: INSTALLATION },
	'principals.promote': { exempt: INSTALLATION },
	'sessions.revoke': { exempt: NARROWS },
	'sessions.revokeAll': { exempt: NARROWS },
	'passwords.issueEnrollment': { exempt: INSTALLATION },
	'passwords.issueReset': { exempt: INSTALLATION },
	'passwords.disable': { exempt: NARROWS },
	'grants.create': { category: 'grants' },
	'grants.update': { category: 'grants' },
	'grants.delete': { category: 'grants' },
	'grantRequests.decide': { exempt: `deciding a pending item: ${ALWAYS_A_PERSON}` },
	'grantApproval.set': { exempt: "Control's mirror of the approval configuration, the provisioning key only" },
	'scopeValues.list': { exempt: 'a read served as a mutation; writes nothing' },
	'apps.setReturnOrigins': { exempt: `where IAM returns an application's sign-in: ${INSTALLATION}` },
	'connections.revoke': { exempt: NARROWS },
	'policies.create': { exempt: `a named policy under \`iam.admin\`: ${INSTALLATION}` },
	'policies.update': { exempt: `a named policy under \`iam.admin\`: ${INSTALLATION}` },
	'policies.delete': { exempt: `a named policy under \`iam.admin\`: ${INSTALLATION}` },
	'apiKeys.provision': { category: 'credentials' },
	'apiKeys.rotate': { category: 'credentials' },
	'apiKeys.revoke': { exempt: NARROWS },
	// The provisioning key's own issuance (workload, membership and connector keys) keeps its rule (ADR-0083 §8).
	'workloads.issueKey': { category: 'credentials' },
	'workloads.revokeKeys': { exempt: NARROWS },
	'membershipKeys.issue': { category: 'credentials' },
	'shareLinks.issue': { category: 'credentials' },
	'shareLinks.revoke': { exempt: NARROWS },
	'terminals.setProfile': { exempt: INSTALLATION },
	'terminals.revoke': { exempt: NARROWS },
	'appPeople.grant': { category: 'grants' },
	'appPeople.revoke': { category: 'grants' },
	'brand.set': { exempt: INSTALLATION },
	'brand.clear': { exempt: INSTALLATION },
	'passwordPolicy.set': { exempt: INSTALLATION },
	'secondFactor.reset': { exempt: INSTALLATION },
}

describe('every IAM administration mutation is judged by an approval category or exempt with its reason', () => {
	test('the shipped router', () => {
		const mutations = routerLeaves(adminRpcRouter).filter((leaf) => leaf.kind === 'mutation').map((leaf) => leaf.method)
		expect(mutations.sort()).toEqual(Object.keys(IAM).sort())
	})
})
