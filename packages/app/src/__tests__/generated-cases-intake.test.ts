// The generated tests' kits over a public intake application: application tables a public procedure writes (one a
// queue), a public procedure with a challenge, and a `scan: true` file kind. The policy probe compiles against the
// policies beside them; the endpoint access kit boots without the challenge's secret and site key or an SPA mount's
// public variable, which no case uses, and its scanner passes the files it seeds. Skips cleanly when
// FABRIKA_TEST_POSTGRES_URL is unset.

import { file, GENERATED_FILE_PREFIX, GENERATED_ROW_PREFIX } from '@fabrika/app/contract'
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
import { visitors } from './fixtures/visitor-intake/src/intake/visitors'

const migrations = mkdtempSync(join(tmpdir(), 'fabrika-generated-cases-intake-'))
writeFileSync(join(migrations, '20261013090000_intake.sql'), migration)
const postgres = await testDatabase({ migrations, label: 'generated-cases-intake.test.ts' })

afterAll(async () => {
	await postgres?.close()
	rmSync(migrations, { recursive: true, force: true })
})

const Register = z.strictObject({ email: z.email(), name: z.string().min(1), challengeToken: z.string() })
const Empty = z.strictObject({})

/** A registration behind a challenge, whose secret and site key no generated case reads. */
const challenged = app.group({}, (r) => ({
	register: r.mutation({
		input: Register,
		output: Empty,
		access: { public: true },
		actions: ['candidates.register'],
		admission: { challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET', siteKey: 'TURNSTILE_SITE_KEY' } },
	}).handle(async ({ input, ctx }) => {
		await ctx.db.app('candidates.register').registrations.insert({ email: input.email, name: input.name })
		return {}
	}),
}))

/** The staff's side of the candidates' files: an upload and a download of a scanning kind. */
const hr = app.group({ callers: ['human'] }, (r) => ({
	attach: r.mutation({
		input: z.strictObject({ candidateId: z.uuid(), file: file('attachments') }),
		output: z.strictObject({ id: z.uuid() }),
		access: { action: 'candidates.attach', on: 'candidate', from: 'candidateId' },
	}).handle(({ input, ctx }) => ctx.db.target.candidate_files.insert({ file: input.file })),
	document: r.query({
		input: z.strictObject({ candidateId: z.uuid(), id: z.uuid() }),
		output: file('attachments'),
		access: { action: 'candidates.read', on: 'candidate', from: 'candidateId' },
	}).handle(async ({ input, ctx }) => (await ctx.db.target.candidate_files.get(input.id)).file),
}))

/** The intake with the challenged registration, a scanning kind, and a public page that serves a config variable. */
const guarded = app.contract((c) => ({
	site: c.spa('/', { dir: 'dist/site', access: { public: true }, browserConfig: ['SIGNUP_URL'] }),
	api: c.rpc('/api', { visitors, challenged, hr }),
	files: { attachments: c.files({ maxBytes: 65536, types: ['application/pdf'], scan: true }) },
}))

if (postgres !== null) {
	describe('the generated tests of a public intake', () => {
		test('a policy probe of a table beside the tables public procedures write compiles and isolates', async () => {
			const kit = policyIsolationKit(intakeContract, tables, 'candidates', postgres)
			expect((await kit.get('own')).status).toBe(200)
			expect((await kit.get('other')).status).toBe(404)
			expect(await kit.list()).toEqual({ status: 200, rows: ['own'] })
		})

		test("the endpoint access kit boots without a challenge's secret and site key or an SPA mount's public variable", async () => {
			const kit = endpointAccessKit(serve(guarded, { database: scoped(tables) }), tables, postgres)
			expect(await kit.anyone('api.visitors.register', { email: 'generated@example.test', name: 'Generated' })).toEqual({ answered: true })
			expect(await kit.anyone('api.challenged.register', { email: 'generated@example.test', name: 'Generated', challengeToken: 'x' })).toEqual({
				answered: false,
				status: 400,
			})
		})

		test("a scanning kind's generated file is taken in its own scope only", async () => {
			const kit = endpointAccessKit(serve(guarded, { database: scoped(tables) }), tables, postgres)
			const upload = { file: `${GENERATED_FILE_PREFIX}attachments` }
			expect([(await kit.own('api.hr.attach', upload)).status, (await kit.denied('api.hr.attach', upload)).status]).toEqual([200, 404])
		})

		test("a scanning kind's seeded file is served in its own scope only", async () => {
			const kit = endpointAccessKit(serve(guarded, { database: scoped(tables) }), tables, postgres)
			const download = { id: `${GENERATED_ROW_PREFIX}candidate_files` }
			expect([(await kit.own('api.hr.document', download)).status, (await kit.denied('api.hr.document', download)).status]).toEqual([200, 404])
		})
	})
}
