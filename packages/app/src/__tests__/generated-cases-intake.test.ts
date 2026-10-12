// The generated tests' kits over a public intake application: its forms' inbox tables, a form with a challenge and a
// `scan: true` collection. The policy probe declares the inbox forms the compiler requires; the endpoint access kit
// boots without the challenge's secret, which no case uses, and its scanner passes the files it seeds. Skips cleanly
// when FABRIKA_TEST_POSTGRES_URL is unset.

import { serve } from '@fabrika/app/implement'
import { endpointAccessKit, policyIsolationKit } from '@fabrika/app/testing/isolation'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { contract as intakeContract } from './fixtures/visitor-intake/fabrika.contract'
import { migration } from './fixtures/visitor-intake/migration'
import { app } from './fixtures/visitor-intake/src/app-kit'
import { tables } from './fixtures/visitor-intake/src/db/tables'
import { Resend } from './fixtures/visitor-intake/src/schemas'

const migrations = mkdtempSync(join(tmpdir(), 'fabrika-generated-cases-intake-'))
writeFileSync(join(migrations, '20261013090000_intake.sql'), migration)
const postgres = await testDatabase({ migrations, label: 'generated-cases-intake.test.ts' })

afterAll(async () => {
	await postgres?.close()
	rmSync(migrations, { recursive: true, force: true })
})

const Register = z.strictObject({ email: z.email(), name: z.string().min(1), challengeToken: z.string() })

/** The intake's tables behind a challenged registration and a scanning collection, served as `src/app.ts` would. */
const guarded = app.contract((c) => ({
	register: c.form('/register', {
		input: Register,
		appendTo: 'registrations',
		challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' },
	}),
	resend: c.form('/resend', { input: Resend, appendTo: 'resend_requests' }),
	files: {
		attachments: c.files({
			owner: 'candidates',
			read: 'candidates.read',
			write: 'candidates.attach',
			delete: 'candidates.process',
			maxBytes: 65536,
			types: ['application/pdf'],
			maxPerOwner: 3,
			scan: true,
		}),
	},
}))

if (postgres !== null) {
	describe('the generated tests of a public intake', () => {
		test('a policy probe of a table beside form inboxes compiles and isolates', async () => {
			const kit = policyIsolationKit(intakeContract, tables, 'candidates', postgres)
			expect((await kit.get('own')).status).toBe(200)
			expect((await kit.get('other')).status).toBe(404)
			expect(await kit.list()).toEqual({ status: 200, rows: ['own'] })
		})

		test("the endpoint access kit boots without a challenge's secret, and a scanning collection's seeded file is served", async () => {
			const kit = endpointAccessKit(serve(guarded, { database: scoped(tables) }), tables, postgres)
			expect(await kit.file('attachments', 'download', 'own')).toEqual({ status: 200 })
			expect(await kit.file('attachments', 'download', 'other')).toEqual({ status: 404 })
		})
	})
}
