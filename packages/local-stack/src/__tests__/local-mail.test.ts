// The composition's mail transport, without Docker: Control holds the `directory` set, Notes (which declares no
// mailer) gets none, IAM keeps its own capture and `none`, Control's registry accepts the set, and it writes where the
// suites read. A suite finds a message by its mailbox, its time and, for an application's, its transport key.

import { readEmailTransportConfig } from '@fabrika/email'
import type { CapturedEmail } from '@fabrika/email/directory'
import { describe, expect, test } from 'bun:test'
import { relative, resolve } from 'node:path'
import { z } from 'zod'
import { LOCAL_CONTROL_EMAIL_PROVIDERS } from '../control-server'
import { MAIL_DIRECTORY, newestMatching } from '../mail-capture'

const WORKSPACE = resolve(import.meta.dir, '..', '..', '..', '..')
const MAIL_VARIABLES = ['FABRIKA_EMAIL_PROVIDER', 'FABRIKA_EMAIL_FROM', 'FABRIKA_EMAIL_DIRECTORY']

const Environment = z.record(z.string(), z.unknown())
const Compose = z.object({
	services: z.object({
		iam: z.object({ environment: Environment }),
		control: z.object({ environment: Environment }),
		notes: z.object({ environment: Environment }),
	}),
})

const compose = Compose.parse(Bun.YAML.parse(await Bun.file(resolve(import.meta.dir, '..', '..', 'compose.yaml')).text()))
const mailOf = (environment: Readonly<Record<string, unknown>>): Record<string, string> =>
	Object.fromEntries(
		Object.entries(environment).flatMap(([name, value]) => (name.startsWith('FABRIKA_EMAIL_') && typeof value === 'string' ? [[name, value]] : [])),
	)

describe("the composition's mail transport", () => {
	test('Control holds the directory set; Notes, which declares no mailer, has none; IAM keeps none beside its own capture', () => {
		const control = mailOf(compose.services.control.environment)
		expect(Object.keys(control).sort()).toEqual([...MAIL_VARIABLES].sort())
		expect(control['FABRIKA_EMAIL_PROVIDER']).toBe('directory')
		expect(mailOf(compose.services.notes.environment)).toEqual({})
		expect(mailOf(compose.services.iam.environment)).toEqual({ FABRIKA_EMAIL_PROVIDER: 'none' })
	})

	test("Control's registry accepts the set, and it captures where the suites read, as the containers mount the workspace", () => {
		const variables = mailOf(compose.services.control.environment)
		expect(readEmailTransportConfig(variables, LOCAL_CONTROL_EMAIL_PROVIDERS)).toMatchObject({ kind: 'provider', provider: 'directory' })
		expect(variables['FABRIKA_EMAIL_DIRECTORY']).toBe(`/workspace/${relative(WORKSPACE, MAIL_DIRECTORY)}`)
	})
})

describe('newestMatching', () => {
	const captured = (to: string, capturedAt: number, idempotencyKey: string): CapturedEmail => ({
		messageId: `${idempotencyKey}-id`,
		idempotencyKey,
		to,
		subject: 'Hello',
		text: 'Hello',
		capturedAt,
	})
	const emails = [
		captured('ada@example.test', 100, 'iam-invitation-1'),
		captured('ada@example.test', 200, 'fabrika:0123:receipt-1'),
		captured('bob@example.test', 300, 'iam-reset-1'),
		captured('ada@example.test', 400, 'iam-invitation-2'),
	]

	test('answers the newest message to the mailbox since the time, from either sender without a key', () => {
		expect(newestMatching(emails, { to: 'ada@example.test', since: 0 })?.idempotencyKey).toBe('iam-invitation-2')
		expect(newestMatching(emails, { to: 'ada@example.test', since: 401 })).toBeUndefined()
		expect(newestMatching(emails, { to: 'bob@example.test', since: 300 })?.idempotencyKey).toBe('iam-reset-1')
	})

	test('with a key, only the message sent under it', () => {
		expect(newestMatching(emails, { to: 'ada@example.test', since: 0, idempotencyKey: 'fabrika:0123:receipt-1' })?.capturedAt).toBe(200)
		expect(newestMatching(emails, { to: 'ada@example.test', since: 201, idempotencyKey: 'fabrika:0123:receipt-1' })).toBeUndefined()
		expect(newestMatching(emails, { to: 'bob@example.test', since: 0, idempotencyKey: 'fabrika:0123:receipt-1' })).toBeUndefined()
	})
})
