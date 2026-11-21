import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { z } from 'zod'
import {
	BUILD_STEPS,
	type CiStep,
	INSTALL_STEP,
	NIGHTLY_POSTGRES_MAJORS,
	POSTGRES_MAJORS,
	POSTGRES_SETTINGS_STEP_NAME,
	POSTGRES_TEST_SETTINGS,
	postgresImage,
	QUALITY_STEPS,
	RELEASE_ARTIFACT_STEPS,
	S3_START_STEP_NAME,
	S3_VALUES,
	SEAWEEDFS_IMAGE,
	TEST_SHARDS,
	TEST_STEPS,
} from '../check-ci'

const ciSchema = z.object({
	jobs: z.record(z.object({
		strategy: z.object({ matrix: z.object({ postgres: z.string().or(z.array(z.string())), shard: z.array(z.number()).optional() }) }).optional(),
		services: z.object({ postgres: z.object({ image: z.string() }) }).optional(),
		env: z.record(z.string()).optional(),
		steps: z.array(z.object({ name: z.string().optional(), if: z.string().optional(), run: z.string().optional() })),
	})),
})

const ci = ciSchema.parse(Bun.YAML.parse(await Bun.file(resolve(import.meta.dir, '..', '..', '.github/workflows/ci.yml')).text()))

const ciRunSteps = (): CiStep[] =>
	Object.entries(ci.jobs).flatMap(([job, { steps }]) =>
		steps.flatMap((step) => step.run === undefined ? [] : [{ job, name: step.name ?? '', run: step.run.trim() }])
	)

describe('check:ci', () => {
	test('runs the run steps of ci.yml, in order, with the install once and SeaweedFS as its own backend', () => {
		const install = ciRunSteps().filter((step) => step.name === INSTALL_STEP.name)
		expect(new Set(install.map((step) => step.run))).toEqual(new Set([INSTALL_STEP.run]))
		expect(install.map((step) => step.job)).toEqual(Object.keys(ci.jobs))

		const backends = [INSTALL_STEP.name, S3_START_STEP_NAME, POSTGRES_SETTINGS_STEP_NAME]
		const rest = ciRunSteps().filter((step) => !backends.includes(step.name))
		const testSteps = TEST_STEPS.map(({ job, name, run }) => ({ job, name, run }))
		expect(rest).toEqual([...QUALITY_STEPS, ...testSteps, ...BUILD_STEPS, ...RELEASE_ARTIFACT_STEPS])
	})

	test('runs the test steps in the shards ci.yml runs them in', () => {
		const job = ci.jobs['test']
		expect(job?.strategy?.matrix.shard).toEqual([...TEST_SHARDS])
		const conditions = TEST_STEPS.map((step) => job?.steps.find((ciStep) => ciStep.name === step.name)?.if)
		expect(conditions).toEqual(TEST_STEPS.map((step) => step.onlyInShard === undefined ? undefined : `matrix.shard == ${step.onlyInShard}`))
	})

	test('starts the backends of the test job', () => {
		const job = ci.jobs['test']
		const majors = (list: readonly string[]): string => JSON.stringify(list)
		expect(job?.strategy?.matrix.postgres).toBe(
			`\${{ fromJSON(github.event_name == 'schedule' && '${majors(NIGHTLY_POSTGRES_MAJORS)}' || '${majors(POSTGRES_MAJORS)}') }}`,
		)
		expect(job?.services?.postgres.image).toBe(postgresImage('${{ matrix.postgres }}'))
		const s3Start = job?.steps.find((step) => step.name === S3_START_STEP_NAME)?.run ?? ''
		expect(s3Start).toContain(SEAWEEDFS_IMAGE)
		for (const [name, value] of Object.entries(S3_VALUES)) expect(job?.env?.[name], name).toBe(value)
		const settings = job?.steps.find((step) => step.name === POSTGRES_SETTINGS_STEP_NAME)?.run ?? ''
		const set = [...settings.matchAll(/alter system set (\w+) = (\w+)/g)].map(([, name, value]) => [name, value])
		expect(Object.fromEntries(set)).toEqual(POSTGRES_TEST_SETTINGS)
	})
})
