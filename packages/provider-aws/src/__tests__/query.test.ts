// The query-protocol client against the fake endpoint: the form body it signs, the result it hands the reader, the
// request id it keeps, an error answer read for its code alone, and every answer of another form refused.

import { describe, expect, test } from 'bun:test'
import { awsQueryClient, CLOUDFORMATION, RDS } from '../aws/query'
import { xmlText } from '../aws/xml'
import { awsError } from './helpers/fake-aws'
import { FAKE_REQUEST_ID, fakeAwsQuery, FakeRawAnswer } from './helpers/fake-aws-query'

describe('awsQueryClient', () => {
	test('posts the action, the version and the flat parameters, and hands the reader the result', async () => {
		const { options, calls } = fakeAwsQuery(CLOUDFORMATION, {
			DescribeStacks: () => '<Stacks><member><StackName>fabrika-main</StackName><StackStatus>CREATE_COMPLETE</StackStatus></member></Stacks>',
		})
		const status = await awsQueryClient(CLOUDFORMATION, options).call('DescribeStacks', {
			StackName: 'fabrika-main',
			'Parameters.member.1.ParameterKey': 'a b&c',
		}, (result) => {
			const member = result?.children[0]?.children[0]
			return member === undefined ? null : xmlText(member, 'StackStatus')
		})
		expect(status).toBe('CREATE_COMPLETE')
		expect(calls).toEqual([{ action: 'DescribeStacks', parameters: { StackName: 'fabrika-main', 'Parameters.member.1.ParameterKey': 'a b&c' } }])
	})

	test('an action without a result hands the reader null', async () => {
		const { options } = fakeAwsQuery(CLOUDFORMATION, { DeleteStack: () => null })
		expect(await awsQueryClient(CLOUDFORMATION, options).call('DeleteStack', { StackName: 'fabrika-main' }, (result) => result)).toBeNull()
	})

	test("an error answer is its code, its status and the request id, never AWS's message", async () => {
		const { options } = fakeAwsQuery(RDS, { DescribeDBInstances: () => awsError('DBInstanceNotFound', 404) })
		const failure = await awsQueryClient(RDS, options).call('DescribeDBInstances', {}, () => null).catch((error: unknown) => error)
		expect(failure).toMatchObject({
			operation: 'DescribeDBInstances',
			code: 'DBInstanceNotFound',
			status: 404,
			requestId: FAKE_REQUEST_ID,
			retryable: false,
		})
		expect(String(failure)).not.toContain('sk_live_quoted_input')
		const throttled = fakeAwsQuery(RDS, { DescribeDBInstances: () => awsError('Throttling', 400) })
		await expect(awsQueryClient(RDS, throttled.options).call('DescribeDBInstances', {}, () => null)).rejects.toMatchObject({
			code: 'Throttling',
			retryable: true,
		})
	})

	test('an error listed under Errors is read too, and the header request id wins over the body one', async () => {
		const listed =
			'<Response><Errors><Error><Code>InvalidParameterValue</Code><Message>quoted</Message></Error></Errors><RequestID>x</RequestID></Response>'
		const { options } = fakeAwsQuery(RDS, { DescribeDBInstances: () => new FakeRawAnswer(listed, 400, { 'x-amzn-RequestId': 'from-the-header' }) })
		await expect(awsQueryClient(RDS, options).call('DescribeDBInstances', {}, () => null)).rejects.toMatchObject({
			code: 'InvalidParameterValue',
			requestId: 'from-the-header',
		})
		const both = fakeAwsQuery(RDS, {
			DescribeDBInstances: () =>
				new FakeRawAnswer(
					`<DescribeDBInstancesResponse><DescribeDBInstancesResult/><ResponseMetadata><RequestId>from-the-body</RequestId></ResponseMetadata></DescribeDBInstancesResponse>`,
					200,
					{ 'x-amzn-RequestId': 'from-the-header' },
				),
		})
		const reader = (): never => {
			throw new Error('the reader refuses')
		}
		await expect(awsQueryClient(RDS, both.options).call('DescribeDBInstances', {}, reader)).rejects.toMatchObject({
			code: 'invalid_answer',
			requestId: 'from-the-header',
		})
	})

	test('an error answer without a code of the expected form is unknown', async () => {
		for (const body of ['<ErrorResponse><Error><Code>no spaces allowed</Code></Error></ErrorResponse>', 'not xml', '']) {
			const { options } = fakeAwsQuery(RDS, { DescribeDBInstances: () => new FakeRawAnswer(body, 500) })
			await expect(awsQueryClient(RDS, options).call('DescribeDBInstances', {}, () => null)).rejects.toMatchObject({ code: 'unknown', retryable: true })
		}
	})

	test('an answer of another form, for another action, or one the reader refuses is invalid_answer', async () => {
		const answers = [
			new FakeRawAnswer('not xml'),
			new FakeRawAnswer('<!DOCTYPE a><DescribeStacksResponse/>'),
			new FakeRawAnswer('<CreateStackResponse><ResponseMetadata><RequestId>x</RequestId></ResponseMetadata></CreateStackResponse>'),
		]
		for (const answer of answers) {
			const { options } = fakeAwsQuery(CLOUDFORMATION, { DescribeStacks: () => answer })
			await expect(awsQueryClient(CLOUDFORMATION, options).call('DescribeStacks', {}, () => null)).rejects.toMatchObject({ code: 'invalid_answer' })
		}
		const { options } = fakeAwsQuery(CLOUDFORMATION, { DescribeStacks: () => '<Stacks/>' })
		const failure = await awsQueryClient(CLOUDFORMATION, options).call('DescribeStacks', {}, () => {
			throw new Error('the reader found no stack')
		}).catch((error: unknown) => error)
		expect(failure).toMatchObject({ code: 'invalid_answer', requestId: FAKE_REQUEST_ID })
	})

	test('refuses an action or a parameter of another form before anything is sent', async () => {
		const { options, calls } = fakeAwsQuery(CLOUDFORMATION, {})
		const client = awsQueryClient(CLOUDFORMATION, options)
		await expect(client.call('describeStacks', {}, () => null)).rejects.toMatchObject({ code: 'invalid_operation' })
		for (const name of ['Action', 'Version', 'a b', '.leading', 'Parameters..member', '1st']) {
			await expect(client.call('DescribeStacks', { [name]: 'x' }, () => null)).rejects.toMatchObject({ code: 'invalid_request' })
		}
		expect(calls).toEqual([])
	})
})
