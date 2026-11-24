// The CodeBuild client against the fake endpoint: what a start sends, how a lost start is found by its token, how a
// build is read and stopped, and that a value of another form, or a status CodeBuild may add later, is refused rather
// than guessed.

import { describe, expect, test } from 'bun:test'
import { BUILD_TOKEN_VARIABLE, codeBuildClient, type CodeBuildStart, type CodeBuildStatus } from '../aws/codebuild'
import { CODEBUILD } from '../aws/json'
import { awsError, fakeAws } from './helpers/fake-aws'

const TOKEN = '0f1e2d3c-4b5a-4968-8776-655443322110'
const ID = `fabrika-apps-build:${TOKEN}`
const OTHER_ID = 'fabrika-apps-build:11111111-2222-4333-8444-555555555555'
const start: CodeBuildStart = {
	project: 'fabrika-apps-build',
	token: TOKEN,
	buildspec: 'version: 0.2\nphases:\n  build:\n    commands:\n      - echo build\n',
	variables: {
		SOURCE_URL: { value: 'https://bucket.s3.eu-central-1.amazonaws.com/run.tgz?X-Amz-Signature=x' },
		SOURCE_MAPS_KEY: { parameter: '/fabrika/main/source-maps' },
	},
	timeoutMinutes: 30,
}
const running = {
	id: ID,
	buildStatus: 'IN_PROGRESS',
	currentPhase: 'BUILD',
	logs: { groupName: '/aws/codebuild/fabrika-apps-build', streamName: 'stream-1' },
}

describe('codeBuildClient', () => {
	test('starts a build with no source, the inline buildspec, its variables plus the token, and privileged mode', async () => {
		const { options, calls } = fakeAws(CODEBUILD, { StartBuild: () => ({ build: running }) })
		expect(await codeBuildClient(options).startBuild(start)).toEqual({
			id: ID,
			status: 'in_progress',
			phase: 'BUILD',
			log: { group: '/aws/codebuild/fabrika-apps-build', stream: 'stream-1' },
		})
		expect(calls).toEqual([
			{
				operation: 'StartBuild',
				target: 'CodeBuild_20161006.StartBuild',
				body: {
					projectName: 'fabrika-apps-build',
					idempotencyToken: TOKEN,
					sourceTypeOverride: 'NO_SOURCE',
					buildspecOverride: start.buildspec,
					environmentVariablesOverride: [
						{ name: 'SOURCE_URL', value: 'https://bucket.s3.eu-central-1.amazonaws.com/run.tgz?X-Amz-Signature=x', type: 'PLAINTEXT' },
						{ name: 'SOURCE_MAPS_KEY', value: '/fabrika/main/source-maps', type: 'PARAMETER_STORE' },
						{ name: BUILD_TOKEN_VARIABLE, value: TOKEN, type: 'PLAINTEXT' },
					],
					timeoutInMinutesOverride: 30,
					privilegedModeOverride: true,
				},
			},
		])
	})

	test("finds a lost start among the project's newest builds by its token, and answers null when none carries it", async () => {
		const withToken = (id: string, token: string) => ({
			id,
			buildStatus: 'IN_PROGRESS',
			environment: { environmentVariables: [{ name: BUILD_TOKEN_VARIABLE, value: token }] },
		})
		const { options, calls } = fakeAws(CODEBUILD, {
			ListBuildsForProject: () => ({ ids: [OTHER_ID, ID] }),
			BatchGetBuilds: () => ({ builds: [withToken(OTHER_ID, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), withToken(ID, TOKEN)] }),
		})
		const codeBuild = codeBuildClient(options)
		expect(await codeBuild.findBuild('fabrika-apps-build', TOKEN)).toMatchObject({ id: ID, status: 'in_progress' })
		expect(calls.map((call) => call.body)).toEqual([
			{ projectName: 'fabrika-apps-build', sortOrder: 'DESCENDING' },
			{ ids: [OTHER_ID, ID] },
		])
		expect(await codeBuild.findBuild('fabrika-apps-build', '99999999-9999-4999-8999-999999999999')).toBeNull()
		const empty = fakeAws(CODEBUILD, { ListBuildsForProject: () => ({ ids: [] }) })
		expect(await codeBuildClient(empty.options).findBuild('fabrika-apps-build', TOKEN)).toBeNull()
		expect(empty.calls.map((call) => call.operation)).toEqual(['ListBuildsForProject'])
	})

	test('reads each status as the provider names it, a build without its log as such, and an unknown one as null', async () => {
		const statuses: readonly (readonly [string, CodeBuildStatus])[] = [
			['SUCCEEDED', 'succeeded'],
			['FAILED', 'failed'],
			['FAULT', 'fault'],
			['TIMED_OUT', 'timed_out'],
			['STOPPED', 'stopped'],
		]
		for (const [buildStatus, status] of statuses) {
			const { options } = fakeAws(CODEBUILD, { BatchGetBuilds: () => ({ builds: [{ id: ID, buildStatus }] }) })
			expect(await codeBuildClient(options).getBuild(ID)).toEqual({ id: ID, status, phase: null, log: null })
		}
		const { options, calls } = fakeAws(CODEBUILD, { BatchGetBuilds: () => ({ builds: [], buildsNotFound: [ID] }) })
		expect(await codeBuildClient(options).getBuild(ID)).toBeNull()
		expect(calls[0]?.body).toEqual({ ids: [ID] })
	})

	test('a status CodeBuild may add later is an invalid answer, never a guess', async () => {
		const { options } = fakeAws(CODEBUILD, { BatchGetBuilds: () => ({ builds: [{ id: ID, buildStatus: 'PAUSED' }] }) })
		await expect(codeBuildClient(options).getBuild(ID)).rejects.toMatchObject({ code: 'invalid_answer' })
	})

	test('stops a build, an unknown one needs no stop, and a refused stop is checked against the build', async () => {
		const stopping = fakeAws(CODEBUILD, { StopBuild: () => ({ build: { ...running, buildStatus: 'STOPPED' } }) })
		expect(await codeBuildClient(stopping.options).stopBuild(ID)).toMatchObject({ status: 'stopped' })
		expect(stopping.calls[0]?.body).toEqual({ id: ID })
		const gone = fakeAws(CODEBUILD, { StopBuild: () => awsError('ResourceNotFoundException') })
		expect(await codeBuildClient(gone.options).stopBuild(ID)).toBeNull()
		const refused = (buildStatus: string | null) =>
			fakeAws(CODEBUILD, {
				StopBuild: () => awsError('InvalidInputException'),
				BatchGetBuilds: () => (buildStatus === null ? { builds: [], buildsNotFound: [ID] } : { builds: [{ id: ID, buildStatus }] }),
			})
		expect(await codeBuildClient(refused('SUCCEEDED').options).stopBuild(ID)).toMatchObject({ status: 'succeeded' })
		expect(await codeBuildClient(refused(null).options).stopBuild(ID)).toBeNull()
		await expect(codeBuildClient(refused('IN_PROGRESS').options).stopBuild(ID)).rejects.toMatchObject({ code: 'InvalidInputException' })
		const denied = fakeAws(CODEBUILD, { StopBuild: () => awsError('AccessDeniedException') })
		await expect(codeBuildClient(denied.options).stopBuild(ID)).rejects.toMatchObject({ code: 'AccessDeniedException' })
	})

	test('refuses a value of another form before anything is sent', async () => {
		const { options, calls } = fakeAws(CODEBUILD, {})
		const codeBuild = codeBuildClient(options)
		const refusals: readonly [Partial<CodeBuildStart>, string][] = [
			[{ project: '-project' }, 'the project name'],
			[{ token: 'not-a-uuid' }, 'the idempotency token'],
			[{ buildspec: '  ' }, 'the buildspec'],
			[{ buildspec: 'buildspec.yml' }, 'the buildspec'],
			[{ buildspec: 'arn:aws:s3:::bucket/buildspec.yml' }, 'the buildspec'],
			[{ timeoutMinutes: 4 }, 'the timeout'],
			[{ timeoutMinutes: 2161 }, 'the timeout'],
			[{ variables: { 'BAD-NAME': { value: 'x' } } }, 'a variable name'],
			[{ variables: { CODEBUILD_BUILD_ID: { value: 'x' } } }, 'a variable name'],
			[{ variables: { AWS_ACCESS_KEY_ID: { value: 'x' } } }, 'a variable name'],
			[{ variables: { [BUILD_TOKEN_VARIABLE]: { value: 'x' } } }, 'a variable name'],
			[{ variables: { KEY: { parameter: 'relative/name' } } }, 'a parameter name'],
		]
		for (const [change, message] of refusals) await expect(codeBuild.startBuild({ ...start, ...change })).rejects.toThrow(message)
		await expect(codeBuild.findBuild('fabrika-apps-build', 'not-a-uuid')).rejects.toThrow('the idempotency token')
		await expect(codeBuild.getBuild('project-only')).rejects.toThrow('the build id')
		await expect(codeBuild.stopBuild('project:not-a-uuid')).rejects.toThrow('the build id')
		expect(calls).toEqual([])
	})
})
