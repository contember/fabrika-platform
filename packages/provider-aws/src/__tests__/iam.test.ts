// The IAM client against the fake query endpoint: the account's ECS service-linked role read first and made only when
// it is missing, for ECS alone; one another caller made meanwhile read again; a role of that name elsewhere refused as
// no service-linked role; and any other failure passed on.

import { describe, expect, test } from 'bun:test'
import { IAM, iamServiceLinkedRoles } from '../aws/iam'
import { awsError } from './helpers/fake-aws'
import { fakeAwsQuery } from './helpers/fake-aws-query'

const ROLE = (path = '/aws-service-role/ecs.amazonaws.com/') =>
	`<Role><Path>${path}</Path><RoleName>AWSServiceRoleForECS</RoleName><RoleId>AROAEXAMPLE</RoleId>`
	+ `<Arn>arn:aws:iam::123456789012:role${path}AWSServiceRoleForECS</Arn></Role>`

describe('iamServiceLinkedRoles', () => {
	test('an existing role is read, never made again', async () => {
		const { options, calls } = fakeAwsQuery(IAM, { GetRole: () => ROLE() })
		expect(await iamServiceLinkedRoles(options).ensureEcsServiceLinkedRole()).toBe('existed')
		expect(calls).toEqual([{ action: 'GetRole', parameters: { RoleName: 'AWSServiceRoleForECS' } }])
	})

	test('a missing role is made for ECS alone, with nothing else named', async () => {
		const { options, calls } = fakeAwsQuery(IAM, { GetRole: () => awsError('NoSuchEntity', 404), CreateServiceLinkedRole: () => ROLE() })
		expect(await iamServiceLinkedRoles(options).ensureEcsServiceLinkedRole()).toBe('created')
		expect(calls).toEqual([
			{ action: 'GetRole', parameters: { RoleName: 'AWSServiceRoleForECS' } },
			{ action: 'CreateServiceLinkedRole', parameters: { AWSServiceName: 'ecs.amazonaws.com' } },
		])
	})

	test('a role another caller made since the read is read again, not guessed', async () => {
		const { options, calls } = fakeAwsQuery(IAM, {
			GetRole: (_, seen) => (seen.filter((call) => call.action === 'GetRole').length === 1 ? awsError('NoSuchEntity', 404) : ROLE()),
			CreateServiceLinkedRole: () => awsError('InvalidInput'),
		})
		expect(await iamServiceLinkedRoles(options).ensureEcsServiceLinkedRole()).toBe('existed')
		expect(calls.map((call) => call.action)).toEqual(['GetRole', 'CreateServiceLinkedRole', 'GetRole'])
		// Still missing after the refusal: the refusal is passed on.
		const gone = fakeAwsQuery(IAM, { GetRole: () => awsError('NoSuchEntity', 404), CreateServiceLinkedRole: () => awsError('InvalidInput') })
		await expect(iamServiceLinkedRoles(gone.options).ensureEcsServiceLinkedRole()).rejects.toMatchObject({ code: 'InvalidInput' })
	})

	test('a role of that name on another path is no service-linked role; any other failure is passed on', async () => {
		const elsewhere = fakeAwsQuery(IAM, { GetRole: () => ROLE('/fabrika/') })
		await expect(iamServiceLinkedRoles(elsewhere.options).ensureEcsServiceLinkedRole()).rejects.toThrow('it is no service-linked role')
		const created = fakeAwsQuery(IAM, { GetRole: () => awsError('NoSuchEntity', 404), CreateServiceLinkedRole: () => ROLE('/fabrika/') })
		await expect(iamServiceLinkedRoles(created.options).ensureEcsServiceLinkedRole()).rejects.toThrow('it is no service-linked role')
		const denied = fakeAwsQuery(IAM, { GetRole: () => awsError('AccessDenied', 403) })
		await expect(iamServiceLinkedRoles(denied.options).ensureEcsServiceLinkedRole()).rejects.toMatchObject({ code: 'AccessDenied' })
		const another = fakeAwsQuery(IAM, { GetRole: () => ROLE().replace('AWSServiceRoleForECS</RoleName>', 'SomethingElse</RoleName>') })
		await expect(iamServiceLinkedRoles(another.options).ensureEcsServiceLinkedRole()).rejects.toMatchObject({ code: 'invalid_answer' })
	})
})
