// The deployer: a role only one repository's workflow in one GitHub Environment may take, compared by GitHub's
// numeric ids, with administrator access inside the platform's ceiling (whose denials `ceilings.test.ts` reads), and
// applied after GitHub's provider, its answer compared with the role it must be.

import type { JsonValue } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import type { StackStatus } from '../../aws/cloudformation'
import type { IamGithubIdentity } from '../../aws/iam'
import {
	applyAwsDeployer,
	AWS_ADMINISTRATOR_ACCESS,
	AWS_DEPLOYER_SESSION_SECONDS,
	AWS_DEPLOYER_STACK,
	AWS_DEPLOYER_SUBJECT_CLAIMS,
	awsDeployerRoleArn,
	awsDeployerStack,
} from '../deployer'

const A = '123456789012'
const INPUT = {
	accountId: A,
	repository: 'acme/fabrika-aws-production',
	repositoryOwnerId: '7654321',
	repositoryId: '123456789',
	environment: 'production',
}
const PROVIDER = `arn:aws:iam::${A}:oidc-provider/token.actions.githubusercontent.com`

/** The stack's resources, read as plain JSON. */
function resources(): Record<string, { Type: string; Properties: Record<string, JsonValue> }> {
	return JSON.parse(JSON.stringify(awsDeployerStack(INPUT).template)).Resources
}

describe('the deployer', () => {
	test("one repository's workflow in one Environment alone takes the role, by GitHub's ids, through GitHub's provider", () => {
		const role = resources()['DeployerRole']
		expect(role?.Properties['AssumeRolePolicyDocument']).toEqual({
			Version: '2012-10-17',
			Statement: [{
				Effect: 'Allow',
				Principal: { Federated: PROVIDER },
				Action: 'sts:AssumeRoleWithWebIdentity',
				Condition: {
					StringEquals: {
						'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
						// A name a deleted repository's successor could take is not compared: the ids are.
						'token.actions.githubusercontent.com:sub': 'repository_owner_id:7654321:repository_id:123456789:environment:production',
					},
				},
			}],
		})
		expect(AWS_DEPLOYER_SUBJECT_CLAIMS).toEqual(['repository_owner_id', 'repository_id', 'context'])
	})

	test("administrator access inside the platform's ceiling, under the platform path Control is denied", () => {
		const { DeployerRole } = resources()
		expect(DeployerRole?.Properties).toMatchObject({
			RoleName: 'fabrika-platform-deployer',
			Path: '/fabrika/platform/',
			ManagedPolicyArns: [AWS_ADMINISTRATOR_ACCESS],
			PermissionsBoundary: `arn:aws:iam::${A}:policy/fabrika/platform/fabrika-platform-boundary`,
			MaxSessionDuration: AWS_DEPLOYER_SESSION_SECONDS,
		})
		// The ceiling is the ceilings stack's, which the deployer may only read.
		expect(Object.keys(resources())).toEqual(['DeployerRole'])
		expect(awsDeployerRoleArn(A)).toBe(`arn:aws:iam::${A}:role/fabrika/platform/fabrika-platform-deployer`)
	})

	test('an input of another form is refused before anything is rendered: each lands in a trust condition', () => {
		expect(() => awsDeployerStack({ ...INPUT, repository: 'acme/*' })).toThrow('not <owner>/<name>')
		expect(() => awsDeployerStack({ ...INPUT, repository: 'acme' })).toThrow('not <owner>/<name>')
		for (const id of ['', '0', '12a', '*', '1:2']) {
			expect(() => awsDeployerStack({ ...INPUT, repositoryId: id })).toThrow("GitHub's ids are not numbers")
			expect(() => awsDeployerStack({ ...INPUT, repositoryOwnerId: id })).toThrow("GitHub's ids are not numbers")
		}
		for (const environment of ['prod*', 'prod:ref:refs/heads/main', '', 'a b']) {
			expect(() => awsDeployerStack({ ...INPUT, environment })).toThrow('GitHub Environment')
		}
		expect(() => awsDeployerStack({ ...INPUT, accountId: '1234' })).toThrow('12 digits')
	})

	test("applying it ensures GitHub's provider first, then the stack, and answers the role the stack names", async () => {
		const calls: string[] = []
		const iam: IamGithubIdentity = {
			ensureGithubOidcProvider: async (accountId) => {
				calls.push(`provider ${accountId}`)
				return 'created'
			},
		}
		let outputs: Record<string, string> = { RoleArn: awsDeployerRoleArn(A) }
		let status: StackStatus | null = null
		let body = ''
		const cloudFormation = {
			findStack: async () => (status === null ? null : { stackId: 'stack-1', status }),
			describeStack: async () => ({ stackId: 'stack-1', status: status ?? 'CREATE_COMPLETE', outputs }),
			getTemplate: async () => body,
			createStack: async ({ name, templateBody }: { name: string; templateBody: string }) => {
				calls.push(`create ${name}`)
				status = 'CREATE_COMPLETE'
				body = templateBody
				return 'stack-1'
			},
			updateStack: async ({ name, templateBody }: { name: string; templateBody: string }) => {
				calls.push(`update ${name}`)
				status = 'UPDATE_COMPLETE'
				body = templateBody
				return 'stack-1'
			},
		}
		const lines: string[] = []
		const run = {
			input: INPUT,
			iam,
			cloudFormation,
			signal: new AbortController().signal,
			sleep: async () => {},
			log: (line: string) => lines.push(line),
		}
		expect(await applyAwsDeployer(run)).toBe(awsDeployerRoleArn(A))
		expect(calls).toEqual([`provider ${A}`, `create ${AWS_DEPLOYER_STACK}`])
		expect(lines).toContain(
			`aws: the deployer role ${awsDeployerRoleArn(A)} trusts acme/fabrika-aws-production's workflow in its production Environment alone`,
		)
		// Run again: the template it holds is the one rendered, so nothing is updated.
		expect(await applyAwsDeployer(run)).toBe(awsDeployerRoleArn(A))
		expect(calls).toEqual([`provider ${A}`, `create ${AWS_DEPLOYER_STACK}`, `provider ${A}`])
		// A stack answering another role is never handed to a workflow.
		outputs = { RoleArn: `arn:aws:iam::${A}:role/other` }
		await expect(applyAwsDeployer(run)).rejects.toThrow(`answers arn:aws:iam::${A}:role/other`)
	})
})
