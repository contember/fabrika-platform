// The IAM client against the fake query endpoint: the account's ECS service-linked role read first and made only when
// it is missing, for ECS alone; one another caller made meanwhile read again; a role of that name elsewhere refused as
// no service-linked role; and any other failure passed on.

import { describe, expect, test } from 'bun:test'
import { IAM, iamGithubIdentity, iamServiceLinkedRoles } from '../aws/iam'
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
		// A made role answered without its path is no answer of IAM's form, never "on another path".
		const pathless = fakeAwsQuery(IAM, {
			GetRole: () => awsError('NoSuchEntity', 404),
			CreateServiceLinkedRole: () => ROLE().replace(/<Path>[^<]*<\/Path>/, ''),
		})
		await expect(iamServiceLinkedRoles(pathless.options).ensureEcsServiceLinkedRole()).rejects.toMatchObject({ code: 'invalid_answer' })
	})
})

describe('iamGithubIdentity', () => {
	const ACCOUNT = '123456789012'
	const ARN = `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`
	const PROVIDER = (...audiences: string[]) =>
		`<Url>token.actions.githubusercontent.com</Url><ClientIDList>${audiences.map((audience) => `<member>${audience}</member>`).join('')}</ClientIDList>`

	test('an existing provider listing the audience is read, never made again or changed', async () => {
		const { options, calls } = fakeAwsQuery(IAM, { GetOpenIDConnectProvider: () => PROVIDER('sigstore', 'sts.amazonaws.com') })
		expect(await iamGithubIdentity(options).ensureGithubOidcProvider(ACCOUNT)).toBe('existed')
		expect(calls).toEqual([{ action: 'GetOpenIDConnectProvider', parameters: { OpenIDConnectProviderArn: ARN } }])
	})

	test('a missing provider is made for GitHub Actions with the one audience AWS takes', async () => {
		const { options, calls } = fakeAwsQuery(IAM, {
			GetOpenIDConnectProvider: () => awsError('NoSuchEntity', 404),
			CreateOpenIDConnectProvider: () => `<OpenIDConnectProviderArn>${ARN}</OpenIDConnectProviderArn>`,
		})
		expect(await iamGithubIdentity(options).ensureGithubOidcProvider(ACCOUNT)).toBe('created')
		expect(calls[1]).toEqual({
			action: 'CreateOpenIDConnectProvider',
			parameters: { Url: 'https://token.actions.githubusercontent.com', 'ClientIDList.member.1': 'sts.amazonaws.com' },
		})
		// An answer naming another provider is no answer.
		const other = fakeAwsQuery(IAM, {
			GetOpenIDConnectProvider: () => awsError('NoSuchEntity', 404),
			CreateOpenIDConnectProvider: () => `<OpenIDConnectProviderArn>arn:aws:iam::${ACCOUNT}:oidc-provider/example.com</OpenIDConnectProviderArn>`,
		})
		await expect(iamGithubIdentity(other.options).ensureGithubOidcProvider(ACCOUNT)).rejects.toMatchObject({ code: 'invalid_answer' })
	})

	test("an existing provider without AWS's audience is refused and left as it is, naming the command that adds it", async () => {
		const { options, calls } = fakeAwsQuery(IAM, { GetOpenIDConnectProvider: () => PROVIDER('sigstore') })
		await expect(iamGithubIdentity(options).ensureGithubOidcProvider(ACCOUNT)).rejects.toThrow(
			`aws iam add-client-id-to-open-id-connect-provider --open-id-connect-provider-arn ${ARN} --client-id sts.amazonaws.com`,
		)
		expect(calls.map((call) => call.action)).toEqual(['GetOpenIDConnectProvider'])
	})

	test('a provider another caller made since the read is read again', async () => {
		const { options, calls } = fakeAwsQuery(IAM, {
			GetOpenIDConnectProvider: (_, seen) =>
				seen.filter((call) => call.action === 'GetOpenIDConnectProvider').length === 1 ? awsError('NoSuchEntity', 404) : PROVIDER('sts.amazonaws.com'),
			CreateOpenIDConnectProvider: () => awsError('EntityAlreadyExists', 409),
		})
		expect(await iamGithubIdentity(options).ensureGithubOidcProvider(ACCOUNT)).toBe('existed')
		expect(calls.map((call) => call.action)).toEqual(['GetOpenIDConnectProvider', 'CreateOpenIDConnectProvider', 'GetOpenIDConnectProvider'])
	})
})
