// The CodeBuild calls the AWS provider makes (ADR-0081): start a build of the installation's project with no source and
// an inline buildspec, read a build, and stop one. The build fetches the source itself through a presigned GET and
// pushes the image to ECR; nothing here activates anything, so a build may always be stopped or left to finish.
//
// A build is started with a caller-chosen idempotency token (the run checkpoint's `buildToken`, recorded before the
// call, ADR-0044), so a repeated start inside the token's window answers the build the first one started.
//
// UNVERIFIED: the operations' input and answer fields, the status names and the token's window follow CodeBuild's API
// reference; none was checked against an account.

import { z } from 'zod'
import { AwsError, type AwsJsonClient } from './json'

/** A CodeBuild project's name. */
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{1,254}$/
/** A build's id: `<project>:<uuid>`. */
const BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,254}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A caller-chosen idempotency token: a lowercase UUID, as the run checkpoint records it. */
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** An environment variable's name. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
/** A Parameter Store name a variable may reference: an absolute path. */
const PARAMETER_NAME = /^\/[A-Za-z0-9_.\-/]{1,1010}$/
/** The bounds of a build's timeout, in minutes. */
export const MIN_BUILD_MINUTES = 5
export const MAX_BUILD_MINUTES = 2160

/** A build's state, as the provider reads it. */
export type CodeBuildStatus = 'in_progress' | 'succeeded' | 'failed' | 'fault' | 'timed_out' | 'stopped'

/** A build: its id, its state, the phase it is in, and where its log is. */
export interface CodeBuildBuild {
	readonly id: string
	readonly status: CodeBuildStatus
	readonly phase: string | null
	readonly log: { readonly group: string; readonly stream: string } | null
}

/**
 * A variable of the build: a plain value, or the name of a Parameter Store parameter CodeBuild reads at start. A plain
 * value is readable by whoever reads the build (`BatchGetBuilds`, the console), so a secret goes by its parameter's
 * name; a short-lived presigned URL may be plain.
 */
export type CodeBuildVariable = { readonly value: string } | { readonly parameter: string }

export interface CodeBuildStart {
	readonly project: string
	/** The idempotency token, recorded in the run checkpoint before the call. */
	readonly token: string
	/** The inline buildspec: the build has no source of its own. */
	readonly buildspec: string
	readonly variables: Readonly<Record<string, CodeBuildVariable>>
	readonly timeoutMinutes: number
}

export interface CodeBuildClient {
	/** Starts a build of `start.project` with no source; a repeat with the same token inside its window answers that build. */
	startBuild(start: CodeBuildStart, signal?: AbortSignal): Promise<CodeBuildBuild>
	/** The build `id`, or `null` when CodeBuild knows none. */
	getBuild(id: string, signal?: AbortSignal): Promise<CodeBuildBuild | null>
	/** Stops the build `id`; a build already finished or unknown is no error. Answers what CodeBuild answered, or `null`. */
	stopBuild(id: string, signal?: AbortSignal): Promise<CodeBuildBuild | null>
}

const STATUSES: Readonly<Record<string, CodeBuildStatus>> = {
	IN_PROGRESS: 'in_progress',
	SUCCEEDED: 'succeeded',
	FAILED: 'failed',
	FAULT: 'fault',
	TIMED_OUT: 'timed_out',
	STOPPED: 'stopped',
}

const buildSchema = z.object({
	id: z.string().regex(BUILD_ID),
	buildStatus: z.string(),
	currentPhase: z.string().optional(),
	logs: z.object({ groupName: z.string().optional(), streamName: z.string().optional() }).optional(),
})
const startedSchema = z.object({ build: buildSchema })
const gotSchema = z.object({ builds: z.array(buildSchema), buildsNotFound: z.array(z.string()).optional() })

/** Refuses a value of another form before anything is sent, naming the argument only. */
function refuse(what: string): never {
	throw new Error(`CodeBuild: ${what} is not one CodeBuild takes`)
}

function buildId(id: string): string {
	return BUILD_ID.test(id) ? id : refuse('the build id')
}

/** The build as the provider reads it; a status CodeBuild may add later is an `invalid_answer`, never a guess. */
function buildOf(operation: string, raw: z.infer<typeof buildSchema>): CodeBuildBuild {
	const status = STATUSES[raw.buildStatus]
	if (status === undefined) throw new AwsError(operation, 'invalid_answer', 200, null, false)
	const group = raw.logs?.groupName
	const stream = raw.logs?.streamName
	return {
		id: raw.id,
		status,
		phase: raw.currentPhase ?? null,
		log: group !== undefined && stream !== undefined ? { group, stream } : null,
	}
}

/** CodeBuild over `json`, a client of the `CODEBUILD` service. */
export function codeBuildClient(json: AwsJsonClient): CodeBuildClient {
	return {
		async startBuild(start, signal) {
			if (!PROJECT_NAME.test(start.project)) refuse('the project name')
			if (!TOKEN.test(start.token)) refuse('the idempotency token')
			if (start.buildspec.trim() === '') refuse('the buildspec')
			if (!Number.isInteger(start.timeoutMinutes) || start.timeoutMinutes < MIN_BUILD_MINUTES || start.timeoutMinutes > MAX_BUILD_MINUTES) {
				refuse('the timeout')
			}
			const environment = Object.entries(start.variables).map(([name, variable]) => {
				if (!VARIABLE_NAME.test(name) || name.startsWith('CODEBUILD_')) refuse('a variable name')
				if ('parameter' in variable) {
					if (!PARAMETER_NAME.test(variable.parameter)) refuse('a parameter name')
					return { name, value: variable.parameter, type: 'PARAMETER_STORE' }
				}
				return { name, value: variable.value, type: 'PLAINTEXT' }
			})
			const started = await json.call(
				'StartBuild',
				{
					projectName: start.project,
					idempotencyToken: start.token,
					sourceTypeOverride: 'NO_SOURCE',
					buildspecOverride: start.buildspec,
					environmentVariablesOverride: environment,
					timeoutInMinutesOverride: start.timeoutMinutes,
					// The build runs Docker to build the image.
					privilegedModeOverride: true,
				},
				startedSchema,
				signal,
			)
			return buildOf('StartBuild', started.build)
		},

		async getBuild(id, signal) {
			const wanted = buildId(id)
			const got = await json.call('BatchGetBuilds', { ids: [wanted] }, gotSchema, signal)
			const found = got.builds.find((build) => build.id === wanted)
			return found === undefined ? null : buildOf('BatchGetBuilds', found)
		},

		async stopBuild(id, signal) {
			const wanted = buildId(id)
			try {
				const stopped = await json.call('StopBuild', { id: wanted }, startedSchema, signal)
				return buildOf('StopBuild', stopped.build)
			} catch (error) {
				// An unknown build, or one that has already finished, needs no stop.
				if (error instanceof AwsError && (error.code === 'ResourceNotFoundException' || error.code === 'InvalidInputException')) return null
				throw error
			}
		},
	}
}
