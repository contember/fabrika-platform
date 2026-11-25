// The CloudFormation client against the fake query endpoint: a stack found by name through ListStacks (every page,
// deleted ones never asked for), its template read as sent, a create that deletes itself on failure and names its
// roles, an update, and every input of another form refused before anything is sent.

import { describe, expect, test } from 'bun:test'
import { cloudFormationClient, STACK_STATUSES } from '../aws/cloudformation'
import { CLOUDFORMATION } from '../aws/query'
import { fakeAwsQuery } from './helpers/fake-aws-query'

const ID = 'arn:aws:cloudformation:eu-central-1:123456789012:stack/fabrika-app-5-notes-prod/0f1e2d3c-4b5a-4968-8776-655443322110'
const OTHER = 'arn:aws:cloudformation:eu-central-1:123456789012:stack/fabrika-app-5-notes-stage/1f1e2d3c-4b5a-4968-8776-655443322110'
const member = (name: string, id: string, status: string) =>
	`<member><StackId>${id}</StackId><StackName>${name}</StackName><StackStatus>${status}</StackStatus></member>`

describe('cloudFormationClient', () => {
	test('finds a stack by name across every page, and asks for every status but deleted', async () => {
		const { options, calls } = fakeAwsQuery(CLOUDFORMATION, {
			ListStacks: (parameters) =>
				parameters['NextToken'] === undefined
					? `<StackSummaries>${member('fabrika-app-5-notes-stage', OTHER, 'CREATE_COMPLETE')}</StackSummaries><NextToken>page-2</NextToken>`
					: `<StackSummaries>${member('fabrika-app-5-notes-prod', ID, 'UPDATE_IN_PROGRESS')}</StackSummaries>`,
		})
		expect(await cloudFormationClient(options).findStack('fabrika-app-5-notes-prod')).toEqual({ stackId: ID, status: 'UPDATE_IN_PROGRESS' })
		expect(calls.map((call) => call.parameters['NextToken'])).toEqual([undefined, 'page-2'])
		const filter = Object.entries(calls[0]?.parameters ?? {}).filter(([key]) => key.startsWith('StackStatusFilter.')).map(([, value]) => value)
		expect(filter).toEqual([...STACK_STATUSES])
		expect(filter).not.toContain('DELETE_COMPLETE')
	})

	test('no live stack of the name is null; a status of another form is an invalid answer', async () => {
		const none = fakeAwsQuery(CLOUDFORMATION, {
			ListStacks: () => `<StackSummaries>${member('fabrika-app-5-notes-stage', OTHER, 'CREATE_COMPLETE')}</StackSummaries>`,
		})
		expect(await cloudFormationClient(none.options).findStack('fabrika-app-5-notes-prod')).toBeNull()
		const odd = fakeAwsQuery(CLOUDFORMATION, {
			ListStacks: () => `<StackSummaries>${member('fabrika-app-5-notes-prod', ID, 'HALF_DONE')}</StackSummaries>`,
		})
		await expect(cloudFormationClient(odd.options).findStack('fabrika-app-5-notes-prod')).rejects.toMatchObject({ code: 'invalid_answer' })
		const twice = fakeAwsQuery(CLOUDFORMATION, {
			ListStacks: () =>
				`<StackSummaries>${member('fabrika-app-5-notes-prod', ID, 'CREATE_COMPLETE')}${
					member('fabrika-app-5-notes-prod', ID, 'CREATE_COMPLETE')
				}</StackSummaries>`,
		})
		await expect(cloudFormationClient(twice.options).findStack('fabrika-app-5-notes-prod')).rejects.toMatchObject({ code: 'invalid_answer' })
	})

	test('reads a stack by its id, a deleted one as DELETE_COMPLETE; an answer about another stack is invalid', async () => {
		const { options, calls } = fakeAwsQuery(CLOUDFORMATION, {
			DescribeStacks: () => `<Stacks>${member('fabrika-app-5-notes-prod', ID, 'DELETE_COMPLETE')}</Stacks>`,
		})
		expect(await cloudFormationClient(options).describeStack(ID)).toEqual({ stackId: ID, status: 'DELETE_COMPLETE', outputs: {} })
		expect(calls[0]?.parameters).toEqual({ StackName: ID })
		const other = fakeAwsQuery(CLOUDFORMATION, {
			DescribeStacks: () => `<Stacks>${member('fabrika-app-5-notes-stage', OTHER, 'CREATE_COMPLETE')}</Stacks>`,
		})
		await expect(cloudFormationClient(other.options).describeStack(ID)).rejects.toMatchObject({ code: 'invalid_answer' })
		await expect(cloudFormationClient(other.options).describeStack('fabrika-app-5-notes-prod')).rejects.toMatchObject({ code: 'invalid_request' })
	})

	test("reads a stack's outputs by key; a key twice or of another form is an invalid answer", async () => {
		const output = (key: string, value: string) => `<member><OutputKey>${key}</OutputKey><OutputValue>${value}</OutputValue></member>`
		const withOutputs = (outputs: string) =>
			fakeAwsQuery(CLOUDFORMATION, {
				DescribeStacks: () =>
					`<Stacks><member><StackId>${ID}</StackId><StackName>fabrika-app-5-notes-prod</StackName><StackStatus>UPDATE_COMPLETE</StackStatus><Outputs>${outputs}</Outputs></member></Stacks>`,
			})
		const read = withOutputs(`${output('SecurityGroupId', 'sg-0123456789abcdef0')}${output('Other', '')}`)
		expect(await cloudFormationClient(read.options).describeStack(ID)).toEqual({
			stackId: ID,
			status: 'UPDATE_COMPLETE',
			outputs: { SecurityGroupId: 'sg-0123456789abcdef0', Other: '' },
		})
		const twice = withOutputs(`${output('SecurityGroupId', 'sg-0123456789abcdef0')}${output('SecurityGroupId', 'sg-0123456789abcdef1')}`)
		await expect(cloudFormationClient(twice.options).describeStack(ID)).rejects.toMatchObject({ code: 'invalid_answer' })
		const odd = withOutputs(output('Security-Group', 'sg-0123456789abcdef0'))
		await expect(cloudFormationClient(odd.options).describeStack(ID)).rejects.toMatchObject({ code: 'invalid_answer' })
	})

	test('reads the template the stack was sent', async () => {
		const { options, calls } = fakeAwsQuery(CLOUDFORMATION, { GetTemplate: () => '<TemplateBody>{"Resources":{"a":&quot;b&quot;}}</TemplateBody>' })
		expect(await cloudFormationClient(options).getTemplate('fabrika-app-5-notes-prod')).toBe('{"Resources":{"a":"b"}}')
		expect(calls[0]?.parameters).toEqual({ StackName: 'fabrika-app-5-notes-prod', TemplateStage: 'Original' })
	})

	test('creates a stack that deletes itself on failure, names its roles, carries its tags and a request token', async () => {
		const { options, calls } = fakeAwsQuery(CLOUDFORMATION, { CreateStack: () => `<StackId>${ID}</StackId>` })
		const id = await cloudFormationClient(options).createStack({
			name: 'fabrika-app-5-notes-prod',
			templateBody: '{"Resources":{}}',
			tags: { 'fabrika:app': 'notes', 'fabrika:env': 'prod' },
			token: '0f1e2d3c-4b5a-4968-8776-655443322110',
		})
		expect(id).toBe(ID)
		expect(calls[0]?.parameters).toEqual({
			StackName: 'fabrika-app-5-notes-prod',
			TemplateBody: '{"Resources":{}}',
			'Capabilities.member.1': 'CAPABILITY_NAMED_IAM',
			OnFailure: 'DELETE',
			ClientRequestToken: '0f1e2d3c-4b5a-4968-8776-655443322110',
			'Tags.member.1.Key': 'fabrika:app',
			'Tags.member.1.Value': 'notes',
			'Tags.member.2.Key': 'fabrika:env',
			'Tags.member.2.Value': 'prod',
		})
	})

	test('updates a stack to a new template', async () => {
		const { options, calls } = fakeAwsQuery(CLOUDFORMATION, { UpdateStack: () => `<StackId>${ID}</StackId>` })
		expect(await cloudFormationClient(options).updateStack({ name: 'fabrika-app-5-notes-prod', templateBody: '{"Resources":{}}', token: 'update-1' }))
			.toBe(ID)
		expect(calls[0]?.parameters).toEqual({
			StackName: 'fabrika-app-5-notes-prod',
			TemplateBody: '{"Resources":{}}',
			'Capabilities.member.1': 'CAPABILITY_NAMED_IAM',
			ClientRequestToken: 'update-1',
		})
	})

	test('an input of another form is refused before anything is sent', async () => {
		const { options, calls } = fakeAwsQuery(CLOUDFORMATION, {})
		const client = cloudFormationClient(options)
		await expect(client.findStack('1-starts-with-a-digit')).rejects.toMatchObject({ code: 'invalid_request' })
		await expect(client.getTemplate('has_underscore')).rejects.toMatchObject({ code: 'invalid_request' })
		await expect(client.createStack({ name: 'fabrika-app-5-notes-prod', templateBody: '', tags: {}, token: 't' })).rejects.toMatchObject({
			code: 'invalid_request',
		})
		await expect(client.updateStack({ name: 'fabrika-app-5-notes-prod', templateBody: 'x'.repeat(51_201), token: 't' })).rejects.toMatchObject({
			code: 'invalid_request',
		})
		await expect(client.updateStack({ name: 'fabrika-app-5-notes-prod', templateBody: '{}', token: '-bad' })).rejects.toMatchObject({
			code: 'invalid_request',
		})
		expect(calls).toEqual([])
	})
})
