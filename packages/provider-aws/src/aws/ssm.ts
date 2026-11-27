// The Parameter Store calls the AWS provider makes (ADR-0081, ADR-0004): an application's secrets are standard
// `SecureString` parameters under one path per application environment, which the task definition references by ARN so
// ECS injects them at start. The provider writes a secret, deletes one, and lists the names under a path (never the
// values) to remove the ones no longer declared. A value never leaves this module in an error or an answer.
//
// No `KeyId` is sent, so every secret is encrypted with the AWS-managed `aws/ssm` key: the execution role needs no
// `kms:Decrypt` grant and there is no key to keep. The consequence: KMS separates no application from another. The only
// boundary between two applications' secrets is the resource scope of the role that reads them
// (`ssm:GetParameters` on `…:parameter/<the application environment's path>/*`). That role is one per application
// environment, scoped to its own path and log group, never one shared by every application.
//
// UNVERIFIED: the operations' input and answer fields, the reserved prefixes, the standard tier's 4 KB, the name's
// length and depth and the page size follow Systems Manager's API reference; none was checked against an account.

import { z } from 'zod'
import { AwsError, awsJsonClient, type AwsJsonClientOptions, SSM } from './json'

/**
 * A parameter name in a path: `/` and at most 15 segments of letters, digits and `_.-`, no empty segment. AWS counts
 * its 1011 characters with the ARN's prefix (`arn:<partition>:ssm:<region>:<account>:parameter`, at most about 61), so
 * a name here is at most 950. AWS has the last word on a name this accepts.
 */
const PARAMETER_NAME = /^(?=.{2,950}$)(?:\/[A-Za-z0-9_.-]+){1,15}$/
/** A path the provider lists: a name, which lists the parameters one level below it. */
const PARAMETER_PATH = PARAMETER_NAME
/** The largest value a standard parameter holds, in bytes. */
export const MAX_SECRET_BYTES = 4096
/** The most names `listNames` reads. */
export const MAX_LISTED_NAMES = 1000
/**
 * The most pages `listNames` reads. A filtered page holds from zero to `PAGE_SIZE` names and may still carry a token,
 * so empty pages are normal in an account with many parameters; this allows 10,000 parameters scanned 50 at a time,
 * twice over.
 */
export const MAX_LISTED_PAGES = 400
const PAGE_SIZE = 50

/** Where a parameter's ARN points: the partition, region and account it lives in. */
export interface SsmLocation {
	readonly partition: string
	readonly region: string
	readonly accountId: string
}

export interface SsmClient {
	/**
	 * Writes `value` as a standard `SecureString` under `name`, replacing an earlier one; answers the new version. An empty
	 * value is refused (a parameter holds at least one character): the caller leaves an empty secret out, or deletes it.
	 */
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
			let pages = 0
			do {
				if (pages === MAX_LISTED_PAGES) throw new AwsError('DescribeParameters', 'too_many_pages', 200, null, false)
				pages += 1
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
					// A name outside the path, or deeper than one level below it, is no answer to this listing: the deploy step
					// would delete a secret it never declared.
					const below = parameter.Name.startsWith(`${path}/`) ? parameter.Name.slice(path.length + 1) : ''
					if (below === '' || below.includes('/')) throw new AwsError('DescribeParameters', 'invalid_answer', 200, null, false)
					names.push(parameter.Name)
				}
				if (names.length > MAX_LISTED_NAMES) throw new AwsError('DescribeParameters', 'too_many_parameters', 200, null, false)
				// A token repeated would read the same page forever.
				if (page.NextToken !== undefined && page.NextToken === next) throw new AwsError('DescribeParameters', 'invalid_answer', 200, null, false)
				next = page.NextToken
			} while (next !== undefined && next !== '')
			return names.sort()
		},
	}
}

/** The operator's own Parameter Store calls: a secret written once, a secret replaced, and a secret read back. */
export interface SsmPlatformSecrets {
	/**
	 * Writes `value` under `name` only when no parameter of the name exists; answers whether it wrote. For a value that
	 * must never change once something was made from it (the database's master password).
	 */
	putSecretOnce(name: string, value: string, signal?: AbortSignal): Promise<boolean>
	/** Writes `value` under `name`, replacing an earlier one. */
	putSecret(name: string, value: string, signal?: AbortSignal): Promise<void>
	/** The value under `name`, decrypted; `null` when there is none. It never reaches an error or a log. */
	readSecret(name: string, signal?: AbortSignal): Promise<string | null>
}

const readSchema = z.object({ Parameter: z.object({ Value: z.string() }) })

/**
 * Parameter Store for the operator's command alone, with the operator's credentials: the platform's parameters
 * (`/fabrika/platform/…`), which no grant of Control's role names. Control never builds this.
 */
export function ssmPlatformSecrets(options: AwsJsonClientOptions): SsmPlatformSecrets {
	const json = awsJsonClient(SSM, options)
	const put = async (name: string, value: string, overwrite: boolean, signal?: AbortSignal) => {
		const parameter = parameterName(name)
		if (value === '' || new TextEncoder().encode(value).byteLength > MAX_SECRET_BYTES) refuse('the value')
		await json.call(
			'PutParameter',
			{ Name: parameter, Value: value, Type: 'SecureString', Overwrite: overwrite, Tier: 'Standard', DataType: 'text' },
			putSchema,
			signal,
		)
	}
	return {
		async putSecretOnce(name, value, signal) {
			try {
				await put(name, value, false, signal)
				return true
			} catch (error) {
				if (error instanceof AwsError && error.code === 'ParameterAlreadyExists') return false
				throw error
			}
		},
		putSecret: (name, value, signal) => put(name, value, true, signal),
		async readSecret(name, signal) {
			const parameter = parameterName(name)
			try {
				const read = await json.call('GetParameter', { Name: parameter, WithDecryption: true }, readSchema, signal)
				return read.Parameter.Value
			} catch (error) {
				if (error instanceof AwsError && error.code === 'ParameterNotFound') return null
				throw error
			}
		},
	}
}
