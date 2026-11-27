// The one IAM call the operator's command makes itself (the query protocol): ensuring the account's ECS service-linked
// role, `AWSServiceRoleForECS`, which places every ECS service's tasks (Control's `CreateService` passes no role). ECS
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
// UNVERIFIED: the API version, the answer's element names and the error codes (`NoSuchEntity`, and `InvalidInput` for
// a role another caller made a moment before) follow IAM's API reference; none was checked against an account.

import { awsQueryClient, type AwsQueryService } from './query'
import { type AwsClientOptions, AwsError } from './transport'
import { xmlOne, xmlText } from './xml'

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
						return xmlText(role, 'Path') ?? ''
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
