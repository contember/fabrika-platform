// The Parameter Store calls the AWS provider makes (ADR-0081, ADR-0004): an application's secrets are standard
// `SecureString` parameters under one path per application environment, which the task definition references by ARN so
// ECS injects them at start. The provider writes a secret, deletes one, and lists the names under a path (never the
// values) to remove the ones no longer declared. A value never leaves this module in an error or an answer.
//
// UNVERIFIED: the operations' input and answer fields, the reserved prefixes, the standard tier's 4 KB and the page
// size follow Systems Manager's API reference; none was checked against an account.

import { z } from 'zod'
import { AwsError, awsJsonClient, type AwsJsonClientOptions, SSM } from './json'

/** A parameter name in a path: `/` and segments of letters, digits and `_.-`, no empty segment, at most 1011. */
const PARAMETER_NAME = /^(?=.{2,1011}$)(?:\/[A-Za-z0-9_.-]+)+$/
/** A path the provider lists: a name, which lists the parameters one level below it. */
const PARAMETER_PATH = PARAMETER_NAME
/** The largest value a standard parameter holds, in bytes. */
export const MAX_SECRET_BYTES = 4096
/** The most names `listNames` reads, as a bound on its pages. */
export const MAX_LISTED_NAMES = 1000
const PAGE_SIZE = 50

/** Where a parameter's ARN points: the partition, region and account it lives in. */
export interface SsmLocation {
	readonly partition: string
	readonly region: string
	readonly accountId: string
}

export interface SsmClient {
	/** Writes `value` as a standard `SecureString` under `name`, replacing an earlier one; answers the new version. */
	putSecret(name: string, value: string, signal?: AbortSignal): Promise<number>
	/** Deletes `name`; answers `false` when there was none. */
	deleteSecret(name: string, signal?: AbortSignal): Promise<boolean>
	/** The names of the parameters one level below `path`, sorted; never a value. */
	listNames(path: string, signal?: AbortSignal): Promise<readonly string[]>
}

const putSchema = z.object({ Version: z.number().int().positive() })
const deletedSchema = z.object({})
const describedSchema = z.object({ Parameters: z.array(z.object({ Name: z.string() })).optional(), NextToken: z.string().optional() })

/** Refuses a value of another form before anything is sent, naming the argument only. */
function refuse(what: string): never {
	throw new Error(`Parameter Store: ${what} is not one Parameter Store takes`)
}

/** A name the provider may write: a path, and not under the prefixes AWS reserves (`aws`, `ssm`, any letter case). */
function parameterName(name: string): string {
	if (!PARAMETER_NAME.test(name)) refuse('the parameter name')
	const first = (name.split('/')[1] ?? '').toLowerCase()
	if (first.startsWith('aws') || first.startsWith('ssm')) refuse('the parameter name')
	return name
}

/** The ARN of the parameter `name` at `location`, as a task definition's `secrets` names it. */
export function parameterArn(location: SsmLocation, name: string): string {
	if (!/^aws(?:-[a-z]{1,10}){0,2}$/.test(location.partition)) refuse('the partition')
	if (!/^[a-z]{2,4}(?:-[a-z]{1,10}){1,3}-\d{1,2}$/.test(location.region)) refuse('the region')
	if (!/^\d{12}$/.test(location.accountId)) refuse('the account')
	return `arn:${location.partition}:ssm:${location.region}:${location.accountId}:parameter${parameterName(name)}`
}

/** Parameter Store at `options.origin`; the client is of the `SSM` service by construction. */
export function ssmClient(options: AwsJsonClientOptions): SsmClient {
	const json = awsJsonClient(SSM, options)
	return {
		async putSecret(name, value, signal) {
			const parameter = parameterName(name)
			if (value === '' || new TextEncoder().encode(value).byteLength > MAX_SECRET_BYTES) refuse('the value')
			const put = await json.call(
				'PutParameter',
				{ Name: parameter, Value: value, Type: 'SecureString', Overwrite: true, Tier: 'Standard', DataType: 'text' },
				putSchema,
				signal,
			)
			return put.Version
		},

		async deleteSecret(name, signal) {
			const parameter = parameterName(name)
			try {
				await json.call('DeleteParameter', { Name: parameter }, deletedSchema, signal)
				return true
			} catch (error) {
				if (error instanceof AwsError && error.code === 'ParameterNotFound') return false
				throw error
			}
		},

		async listNames(path, signal) {
			if (!PARAMETER_PATH.test(path)) refuse('the path')
			const names: string[] = []
			let next: string | undefined
			do {
				const page = await json.call(
					'DescribeParameters',
					{
						ParameterFilters: [{ Key: 'Path', Option: 'OneLevel', Values: [path] }],
						MaxResults: PAGE_SIZE,
						...(next === undefined ? {} : { NextToken: next }),
					},
					describedSchema,
					signal,
				)
				for (const parameter of page.Parameters ?? []) {
					// A name outside the path is no answer to this listing.
					if (!parameter.Name.startsWith(`${path}/`)) throw new AwsError('DescribeParameters', 'invalid_answer', 200, null, false)
					names.push(parameter.Name)
				}
				if (names.length > MAX_LISTED_NAMES) throw new AwsError('DescribeParameters', 'too_many_parameters', 200, null, false)
				next = page.NextToken
			} while (next !== undefined && next !== '')
			return names.sort()
		},
	}
}
