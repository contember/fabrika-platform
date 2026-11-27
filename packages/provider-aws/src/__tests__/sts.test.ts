// The STS client against the fake query endpoint: the account the credentials belong to, and an answer without one of
// the expected form refused rather than guessed.

import { describe, expect, test } from 'bun:test'
import { STS, stsClient } from '../aws/sts'
import { fakeAwsQuery } from './helpers/fake-aws-query'

describe('stsClient', () => {
	test("answers the credentials' account", async () => {
		const { options, calls } = fakeAwsQuery(STS, {
			GetCallerIdentity: () => '<Arn>arn:aws:iam::123456789012:user/operator</Arn><UserId>AIDAEXAMPLE</UserId><Account>123456789012</Account>',
		})
		expect(await stsClient(options).callerAccount()).toBe('123456789012')
		expect(calls).toEqual([{ action: 'GetCallerIdentity', parameters: {} }])
	})

	test('an answer without an account of the expected form is no answer', async () => {
		const { options } = fakeAwsQuery(STS, { GetCallerIdentity: () => '<Account>not-an-account</Account>' })
		await expect(stsClient(options).callerAccount()).rejects.toMatchObject({ code: 'invalid_answer' })
	})
})
