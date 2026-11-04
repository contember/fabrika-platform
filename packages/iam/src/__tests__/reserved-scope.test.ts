// `~` scope types are IAM's derived pseudo-scopes (`~rel`): no grant names one at ingress, so a relation entry in a
// token always comes from a role's `via` on a global grant.

import { describe, expect, test } from 'bun:test'
import { parseScope } from '../admin/grant-support'

describe('a grant scope at ingress', () => {
	test('a reserved scope type is refused; a dimension and no scope are accepted', () => {
		expect(parseScope({ scopeType: '~rel', scopeValue: 'assignee' })).toEqual({ ok: false })
		expect(parseScope({ scopeType: '~other', scopeValue: 'x' })).toEqual({ ok: false })
		expect(parseScope({ scopeType: 'team', scopeValue: 'acme' })).toEqual({ ok: true, scopeType: 'team', scopeValue: 'acme' })
		expect(parseScope({})).toEqual({ ok: true, scopeType: null, scopeValue: null })
	})
})
