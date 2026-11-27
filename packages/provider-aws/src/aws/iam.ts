// The IAM calls the operator's command makes itself (the query protocol), for two things an account holds once whoever
// made them, which no stack may own.
//
// **GitHub Actions' OIDC provider** (`iamGithubIdentity`), which the deployer's role trusts (`installation/deployer.ts`):
// read first (`GetOpenIDConnectProvider`), made with `sts.amazonaws.com` as its one audience only when missing. An
// existing one is never changed, since it may serve other workflows of the account: one without that audience is
// refused, naming the command that adds it.
//
// **The account's ECS service-linked role**, `AWSServiceRoleForECS`, which places every ECS service's tasks (Control's `CreateService` passes no role). ECS
// makes it on a first service in the console, but not reliably when the first service comes from CloudFormation, and a
// stack cannot hold it: it may already exist, made by anything else in the account, and a stack that created it would
// delete it with the stack.
//
// - `GetRole` first: an existing role is read, never made again. Its path must be the one AWS gives ECS's role
//   (`/aws-service-role/ecs.amazonaws.com/`): a role of that name elsewhere would be no service-linked role.
// - `CreateServiceLinkedRole` for `ecs.amazonaws.com` alone, with no description or suffix: AWS names the role and
//   attaches its managed policy. A service-linked role takes no permissions boundary; AWS owns its policy, and nothing
//   here can widen it.
// - Control never builds this client. Its role holds no IAM action on this role.
//
// IAM is global: its endpoint is `iam.amazonaws.com`, signed for `us-east-1`.
//
// UNVERIFIED: the API version, the answer's element names and the error codes (`NoSuchEntity`; `InvalidInput` for a
// role and `EntityAlreadyExists` for a provider another caller made a moment before), and that a provider created
// without a thumbprint takes IAM's own, follow IAM's API reference; none was checked against an account.

import { awsQueryClient, type AwsQueryService } from './query'
import { type AwsClientOptions, AwsError } from './transport'
import { xmlChildren, xmlOne, xmlOptional, xmlText } from './xml'

export const IAM: AwsQueryService = { service: 'iam', version: '2010-05-08' }
/** IAM's one endpoint in AWS's commercial partition, and the region it signs for. */
export const AWS_IAM_ORIGIN = 'https://iam.amazonaws.com'
export const AWS_IAM_SIGNING_REGION = 'us-east-1'

/** The ECS service-linked role's name and path, as AWS makes them. */
export const ECS_SERVICE_LINKED_ROLE = 'AWSServiceRoleForECS'
const ECS_SERVICE_LINKED_PATH = '/aws-service-role/ecs.amazonaws.com/'

export interface IamServiceLinkedRoles {
	/** Makes the account's ECS service-linked role unless it exists; answers which. */
	ensureEcsServiceLinkedRole(signal?: AbortSignal): Promise<'existed' | 'created'>
}

/** IAM at `options.origin` (`AWS_IAM_ORIGIN`, signed for `AWS_IAM_SIGNING_REGION`), from the operator's credentials. */
export function iamServiceLinkedRoles(options: AwsClientOptions): IamServiceLinkedRoles {
	const query = awsQueryClient(IAM, options)
	/** The role's path, or `null` when the account has none of that name. */
	const roleRead = async (signal?: AbortSignal): Promise<string | null> => {
		try {
			return await query.call(
				'GetRole',
				{ RoleName: ECS_SERVICE_LINKED_ROLE },
				(result) => {
					const role = result === null ? null : xmlOne(result, 'Role')
					if (role === null || xmlText(role, 'RoleName') !== ECS_SERVICE_LINKED_ROLE) throw new Error('no role')
					const path = xmlText(role, 'Path')
					if (path === null) throw new Error('no path')
					return path
				},
				signal,
			)
		} catch (error) {
			if (error instanceof AwsError && error.code === 'NoSuchEntity') return null
			throw error
		}
	}
	const checked = (path: string): void => {
		if (path !== ECS_SERVICE_LINKED_PATH) {
			throw new Error(`aws: the account's ${ECS_SERVICE_LINKED_ROLE} is at ${path}, not ${ECS_SERVICE_LINKED_PATH}: it is no service-linked role`)
		}
	}
	return {
		async ensureEcsServiceLinkedRole(signal) {
			const existing = await roleRead(signal)
			if (existing !== null) {
				checked(existing)
				return 'existed'
			}
			let created: string
			try {
				created = await query.call(
					'CreateServiceLinkedRole',
					{ AWSServiceName: 'ecs.amazonaws.com' },
					(result) => {
						const role = result === null ? null : xmlOne(result, 'Role')
						if (role === null || xmlText(role, 'RoleName') !== ECS_SERVICE_LINKED_ROLE) throw new Error('another role')
						// No path is no answer of the form IAM gives: `invalid_answer`, as `GetRole`'s read says.
						const path = xmlText(role, 'Path')
						if (path === null) throw new Error('no path')
						return path
					},
					signal,
				)
			} catch (error) {
				// Made by another caller since the read: read it again rather than guess.
				if (!(error instanceof AwsError && error.code === 'InvalidInput')) throw error
				const made = await roleRead(signal)
				if (made === null) throw error
				checked(made)
				return 'existed'
			}
			checked(created)
			return 'created'
		},
	}
}

/** GitHub Actions' token issuer, as IAM names an OIDC provider (no scheme) and as it is created (with one). */
export const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com'
/** The audience GitHub's token carries for AWS, which the provider must list and the deployer's trust requires. */
export const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com'

/** The account's GitHub OIDC provider's ARN: one per issuer per account, whoever made it. */
export function githubOidcProviderArn(accountId: string): string {
	return `arn:aws:iam::${accountId}:oidc-provider/${GITHUB_OIDC_HOST}`
}

export interface IamGithubIdentity {
	/**
	 * Makes the account's OIDC provider for GitHub Actions unless it exists, listing `sts.amazonaws.com`; answers which.
	 * An existing one is never changed: it may serve other workflows, so one that lacks the audience is refused.
	 */
	ensureGithubOidcProvider(accountId: string, signal?: AbortSignal): Promise<'existed' | 'created'>
}

/** IAM at `options.origin` for GitHub's OIDC provider, from the operator's credentials. */
export function iamGithubIdentity(options: AwsClientOptions): IamGithubIdentity {
	const query = awsQueryClient(IAM, options)
	/** The provider's audiences, or `null` when the account has none for GitHub. */
	const audiences = async (arn: string, signal?: AbortSignal): Promise<readonly string[] | null> => {
		try {
			return await query.call(
				'GetOpenIDConnectProvider',
				{ OpenIDConnectProviderArn: arn },
				(result) => {
					if (result === null) throw new Error('no provider')
					const list = xmlOptional(result, 'ClientIDList')
					return list === null ? [] : xmlChildren(list, 'member').map((member) => member.text)
				},
				signal,
			)
		} catch (error) {
			if (error instanceof AwsError && error.code === 'NoSuchEntity') return null
			throw error
		}
	}
	const checked = (arn: string, listed: readonly string[]): void => {
		if (!listed.includes(GITHUB_OIDC_AUDIENCE)) {
			throw new Error(
				`aws: the account's GitHub OIDC provider (${arn}) lists no ${GITHUB_OIDC_AUDIENCE} audience; it may serve other workflows, so it is `
					+ `not changed here. Add it: aws iam add-client-id-to-open-id-connect-provider --open-id-connect-provider-arn ${arn} `
					+ `--client-id ${GITHUB_OIDC_AUDIENCE}`,
			)
		}
	}
	return {
		async ensureGithubOidcProvider(accountId, signal) {
			const arn = githubOidcProviderArn(accountId)
			const existing = await audiences(arn, signal)
			if (existing !== null) {
				checked(arn, existing)
				return 'existed'
			}
			try {
				const created = await query.call(
					'CreateOpenIDConnectProvider',
					{ Url: `https://${GITHUB_OIDC_HOST}`, 'ClientIDList.member.1': GITHUB_OIDC_AUDIENCE },
					(result) => (result === null ? null : xmlText(result, 'OpenIDConnectProviderArn')),
					signal,
				)
				if (created !== arn) throw new AwsError('CreateOpenIDConnectProvider', 'invalid_answer', 200, null, false)
				return 'created'
			} catch (error) {
				// Made by another caller since the read: read it again rather than guess.
				if (!(error instanceof AwsError && error.code === 'EntityAlreadyExists')) throw error
				const made = await audiences(arn, signal)
				if (made === null) throw error
				checked(arn, made)
				return 'existed'
			}
		},
	}
}
