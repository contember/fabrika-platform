// The CodeBuild client against the fake endpoint: what a start sends, how a build is read and stopped, and that a
// value of another form, or a status CodeBuild may add later, is refused rather than guessed.

import { describe, expect, test } from 'bun:test'
import { codeBuildClient, type CodeBuildStart, type CodeBuildStatus } from '../aws/codebuild'
import { CODEBUILD } from '../aws/json'
import { awsError, fakeAws } from './helpers/fake-aws'

const ID = 'fabrika-apps-build:0f1e2d3c-4b5a-4968-8776-655443322110'
const start: CodeBuildStart = {
	project: 'fabrika-apps-build',
	token: '0f1e2d3c-4b5a-4968-8776-655443322110',
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
	test('starts a build with no source, the inline buildspec, its variables, the token and privileged mode', async () => {
		const { client, calls } = fakeAws(CODEBUILD, { StartBuild: () => ({ build: running }) })
		expect(await codeBuildClient(client).startBuild(start)).toEqual({
			id: ID,
			status: 'in_progress',
			phase: 'BUILD',
			log: { group: '/aws/codebuild/fabrika-apps-build', stream: 'stream-1' },
		})
		expect(calls).toEqual([
			{
				operation: 'StartBuild',
				body: {
					projectName: 'fabrika-apps-build',
					idempotencyToken: '0f1e2d3c-4b5a-4968-8776-655443322110',
					sourceTypeOverride: 'NO_SOURCE',
					buildspecOverride: start.buildspec,
					environmentVariablesOverride: [
						{ name: 'SOURCE_URL', value: 'https://bucket.s3.eu-central-1.amazonaws.com/run.tgz?X-Amz-Signature=x', type: 'PLAINTEXT' },
						{ name: 'SOURCE_MAPS_KEY', value: '/fabrika/main/source-maps', type: 'PARAMETER_STORE' },
					],
					timeoutInMinutesOverride: 30,
					privilegedModeOverride: true,
				},
			},
		])
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
			const { client } = fakeAws(CODEBUILD, { BatchGetBuilds: () => ({ builds: [{ id: ID, buildStatus }] }) })
			expect(await codeBuildClient(client).getBuild(ID)).toEqual({ id: ID, status, phase: null, log: null })
		}
		const { client, calls } = fakeAws(CODEBUILD, { BatchGetBuilds: () => ({ builds: [], buildsNotFound: [ID] }) })
		expect(await codeBuildClient(client).getBuild(ID)).toBeNull()
		expect(calls[0]?.body).toEqual({ ids: [ID] })
	})

	test('a status CodeBuild may add later is an invalid answer, never a guess', async () => {
		const { client } = fakeAws(CODEBUILD, { BatchGetBuilds: () => ({ builds: [{ id: ID, buildStatus: 'PAUSED' }] }) })
		await expect(codeBuildClient(client).getBuild(ID)).rejects.toMatchObject({ code: 'invalid_answer' })
	})

	test('stops a build, and an unknown or finished one needs no stop', async () => {
		const { client, calls } = fakeAws(CODEBUILD, { StopBuild: () => ({ build: { ...running, buildStatus: 'STOPPED' } }) })
		expect(await codeBuildClient(client).stopBuild(ID)).toMatchObject({ status: 'stopped' })
		expect(calls[0]?.body).toEqual({ id: ID })
		for (const code of ['ResourceNotFoundException', 'InvalidInputException']) {
			const gone = fakeAws(CODEBUILD, { StopBuild: () => awsError(code) })
			expect(await codeBuildClient(gone.client).stopBuild(ID)).toBeNull()
		}
		const denied = fakeAws(CODEBUILD, { StopBuild: () => awsError('AccessDeniedException') })
		await expect(codeBuildClient(denied.client).stopBuild(ID)).rejects.toMatchObject({ code: 'AccessDeniedException' })
	})

	test('refuses a value of another form before anything is sent', async () => {
		const { client, calls } = fakeAws(CODEBUILD, {})
		const codeBuild = codeBuildClient(client)
		const refusals: readonly [Partial<CodeBuildStart>, string][] = [
			[{ project: '-project' }, 'the project name'],
			[{ token: 'not-a-uuid' }, 'the idempotency token'],
			[{ buildspec: '  ' }, 'the buildspec'],
			[{ timeoutMinutes: 4 }, 'the timeout'],
			[{ timeoutMinutes: 2161 }, 'the timeout'],
			[{ variables: { 'BAD-NAME': { value: 'x' } } }, 'a variable name'],
			[{ variables: { CODEBUILD_BUILD_ID: { value: 'x' } } }, 'a variable name'],
			[{ variables: { KEY: { parameter: 'relative/name' } } }, 'a parameter name'],
		]
		for (const [change, message] of refusals) await expect(codeBuild.startBuild({ ...start, ...change })).rejects.toThrow(message)
		await expect(codeBuild.getBuild('project-only')).rejects.toThrow('the build id')
		await expect(codeBuild.stopBuild('project:not-a-uuid')).rejects.toThrow('the build id')
		expect(calls).toEqual([])
	})
})
