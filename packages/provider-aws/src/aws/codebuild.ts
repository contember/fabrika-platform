// The CodeBuild calls the AWS provider makes (ADR-0081): start a build of the installation's project with no source and
// an inline buildspec, find a build by the token it was started with, read a build, and stop one. The build fetches the
// source itself through a presigned GET and pushes the image to ECR; nothing here activates anything, so a build may
// always be stopped or left to finish.
//
// A build is started with the run checkpoint's `buildToken` (recorded before the call, ADR-0044) as its idempotency
// token. That token holds for five minutes only, and a repeat inside them must send the identical body (the same
// presigned URL included), or CodeBuild refuses it as a parameter mismatch. So a lost start is never settled by a blind
// repeat: the token also travels as the plain variable `FABRIKA_BUILD_TOKEN`, and `findBuild` finds the build by it.
//
// The variables' names are the provider's own, never an application's: `CODEBUILD_` and `AWS_` names are refused, since
// an `AWS_` variable would change which identity the build's AWS calls use.
//
// UNVERIFIED: the operations' input and answer fields, the status names, the token's window and how StopBuild answers a
// finished build follow CodeBuild's API reference; none was checked against an account.

import { z } from 'zod'
import { AwsError, awsJsonClient, type AwsJsonClientOptions, CODEBUILD } from './json'

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
/** An inline buildspec: YAML that opens with its version. A single line would be read as a path or an S3 ARN instead. */
const INLINE_BUILDSPEC = /^\s*version:\s*[^\n]*\n[\s\S]*\S/
/** The variable that carries the idempotency token, so the build can be found by it. */
export const BUILD_TOKEN_VARIABLE = 'FABRIKA_BUILD_TOKEN'
/** The bounds of a build's timeout, in minutes. */
export const MIN_BUILD_MINUTES = 5
export const MAX_BUILD_MINUTES = 2160
/** How many of a project's newest builds `findBuild` reads: one page of `ListBuildsForProject`. */
export const FIND_BUILD_DEPTH = 100

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
	/** The inline buildspec (YAML opening with `version:`): the build has no source of its own. */
	readonly buildspec: string
	readonly variables: Readonly<Record<string, CodeBuildVariable>>
	readonly timeoutMinutes: number
}

export interface CodeBuildClient {
	/** Starts a build of `start.project` with no source. Only an identical repeat inside five minutes answers the same build. */
	startBuild(start: CodeBuildStart, signal?: AbortSignal): Promise<CodeBuildBuild>
	/** The build `project` started with `token`, among its newest `FIND_BUILD_DEPTH`, or `null`: how a lost start is settled. */
	findBuild(project: string, token: string, signal?: AbortSignal): Promise<CodeBuildBuild | null>
	/** The build `id`, or `null` when CodeBuild knows none. */
	getBuild(id: string, signal?: AbortSignal): Promise<CodeBuildBuild | null>
	/**
	 * Stops the build `id`. An unknown build answers `null`. A refused stop (`InvalidInputException`) is checked: the build
	 * is answered when it has finished, and the refusal is thrown when it is still running.
	 */
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
	environment: z.object({ environmentVariables: z.array(z.object({ name: z.string(), value: z.string().optional() })).optional() }).optional(),
})
const startedSchema = z.object({ build: buildSchema })
const gotSchema = z.object({ builds: z.array(buildSchema), buildsNotFound: z.array(z.string()).optional() })
const listedSchema = z.object({ ids: z.array(z.string()).optional() })

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

/** CodeBuild at `options.origin`; the client is of the `CODEBUILD` service by construction. */
export function codeBuildClient(options: AwsJsonClientOptions): CodeBuildClient {
	const json = awsJsonClient(CODEBUILD, options)

	async function getBuild(id: string, signal?: AbortSignal): Promise<CodeBuildBuild | null> {
		const wanted = buildId(id)
		const got = await json.call('BatchGetBuilds', { ids: [wanted] }, gotSchema, signal)
		const found = got.builds.find((build) => build.id === wanted)
		return found === undefined ? null : buildOf('BatchGetBuilds', found)
	}

	return {
		async startBuild(start, signal) {
			if (!PROJECT_NAME.test(start.project)) refuse('the project name')
			if (!TOKEN.test(start.token)) refuse('the idempotency token')
			if (!INLINE_BUILDSPEC.test(start.buildspec)) refuse('the buildspec')
			if (!Number.isInteger(start.timeoutMinutes) || start.timeoutMinutes < MIN_BUILD_MINUTES || start.timeoutMinutes > MAX_BUILD_MINUTES) {
				refuse('the timeout')
			}
			const environment = Object.entries(start.variables).map(([name, variable]) => {
				if (!VARIABLE_NAME.test(name) || name.startsWith('CODEBUILD_') || name.startsWith('AWS_') || name === BUILD_TOKEN_VARIABLE) {
					refuse('a variable name')
				}
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
					environmentVariablesOverride: [...environment, { name: BUILD_TOKEN_VARIABLE, value: start.token, type: 'PLAINTEXT' }],
					timeoutInMinutesOverride: start.timeoutMinutes,
					// The build runs Docker to build the image.
					privilegedModeOverride: true,
				},
				startedSchema,
				signal,
			)
			return buildOf('StartBuild', started.build)
		},

		async findBuild(project, token, signal) {
			if (!PROJECT_NAME.test(project)) refuse('the project name')
			if (!TOKEN.test(token)) refuse('the idempotency token')
			const listed = await json.call('ListBuildsForProject', { projectName: project, sortOrder: 'DESCENDING' }, listedSchema, signal)
			const ids = (listed.ids ?? []).filter((id) => BUILD_ID.test(id)).slice(0, FIND_BUILD_DEPTH)
			if (ids.length === 0) return null
			const got = await json.call('BatchGetBuilds', { ids }, gotSchema, signal)
			const found = got.builds.find((build) =>
				build.environment?.environmentVariables?.some((variable) => variable.name === BUILD_TOKEN_VARIABLE && variable.value === token)
			)
			return found === undefined ? null : buildOf('BatchGetBuilds', found)
		},

		getBuild,

		async stopBuild(id, signal) {
			const wanted = buildId(id)
			try {
				const stopped = await json.call('StopBuild', { id: wanted }, startedSchema, signal)
				return buildOf('StopBuild', stopped.build)
			} catch (error) {
				if (!(error instanceof AwsError)) throw error
				if (error.code === 'ResourceNotFoundException') return null
				if (error.code !== 'InvalidInputException') throw error
				// The reference does not say this code means "already finished", so the build says it.
				const build = await getBuild(wanted, signal)
				if (build === null || build.status !== 'in_progress') return build
				throw error
			}
		},
	}
}
