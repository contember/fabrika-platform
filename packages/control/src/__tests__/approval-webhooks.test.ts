// A webhook in the conservative access diff: a new one is shown with its verifier and what one binding reaches, and a
// mutation that declares `binds` creates its bindings and sees their secrets, which widens with closer review.

import { compileContract, defineApp, WebhookSecret } from '@fabrika/app/contract'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { tables } from '../../../app/src/__tests__/kit-fixture/src/db/tables'
import { Push } from '../../../app/src/__tests__/kit-fixture/src/schemas'
import { vocabulary } from '../../../app/src/__tests__/kit-fixture/src/vocabulary'
import { classifyAccess, snapshotDeviations } from '../approval/diff'
import type { AccessSnapshot } from '../approval/snapshot'

const app = defineApp(vocabulary, tables)

const ledger = app.webhook('/hooks/ledger', {
	scheme: { hmac: { header: 'X-Ledger-Signature', algorithm: 'sha256', encoding: 'hex', signed: 'body' } },
	boundTo: 'app',
	actions: ['crm.write'],
	input: Push,
}).handle(async () => {})

const Account = z.strictObject({ account: z.string() })
const access = { action: 'members.manage', app: true } as const

const GROUPS = {
	plain: app.group({ callers: ['human'] }, (r) => ({
		connect: r.mutation({ input: Account, output: Account, access }).handle(({ input }) => input),
	})),
	binding: app.group({ callers: ['human'] }, (r) => ({
		connect: r.mutation({ input: Account, output: WebhookSecret, access, binds: 'ledger' })
			.handle(({ input, ctx }) => ctx.webhooks('ledger').bind(ctx.app, input.account)),
	})),
}

function snapshot(group: keyof typeof GROUPS, hooked = true): AccessSnapshot {
	const ledgers = GROUPS[group]
	const contract = hooked
		? app.contract((c) => ({ api: c.rpc('/api', { ledgers }), ledger }))
		: app.contract((c) => ({ api: c.rpc('/api', { ledgers }) }))
	return { version: 1, contract: compileContract(contract, tables), migrations: [], checker: '0.0.0' }
}

describe('webhooks in the approval diff', () => {
	test('a new webhook names its verifier and that one binding serves the whole application', () => {
		const lines = classifyAccess(snapshot('plain', false), snapshot('plain')).changes.map((change) => change.line)
		expect(lines).toContain(
			'New webhook mount `ledger`, verified by an HMAC-SHA256 in `X-Ledger-Signature`, its bindings once for the whole application',
		)
	})

	test('binds widens with closer review, dropping it narrows, and it is no deviation', () => {
		const binds = classifyAccess(snapshot('plain'), snapshot('binding')).changes
		expect(binds).toContainEqual({
			effect: 'widens',
			review: 'closer',
			line: "Endpoint `api.ledgers.connect` binds webhook `ledger`: it creates and removes its bindings, and sees each new binding's secret",
		})
		expect(classifyAccess(snapshot('binding'), snapshot('plain')).changes).toContainEqual({
			effect: 'narrows',
			line: 'Endpoint `api.ledgers.connect` no longer binds webhook `ledger`',
		})
		expect(snapshotDeviations(snapshot('binding'))).toEqual([])
	})
})
