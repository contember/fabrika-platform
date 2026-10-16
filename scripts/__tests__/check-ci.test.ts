import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { z } from 'zod'
import {
	BUILD_STEPS,
	type CiStep,
	INSTALL_STEP,
	POSTGRES_MAJORS,
	postgresImage,
	QUALITY_STEPS,
	RELEASE_ARTIFACT_STEPS,
	S3_START_STEP_NAME,
	S3_VALUES,
	SEAWEEDFS_IMAGE,
	TEST_STEP,
} from '../check-ci'

const ciSchema = z.object({
	jobs: z.record(z.object({
		strategy: z.object({ matrix: z.object({ postgres: z.array(z.string()) }) }).optional(),
		services: z.object({ postgres: z.object({ image: z.string() }) }).optional(),
		env: z.record(z.string()).optional(),
		steps: z.array(z.object({ name: z.string().optional(), run: z.string().optional() })),
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

		const rest = ciRunSteps().filter((step) => step.name !== INSTALL_STEP.name && step.name !== S3_START_STEP_NAME)
		expect(rest).toEqual([...QUALITY_STEPS, TEST_STEP, ...BUILD_STEPS, ...RELEASE_ARTIFACT_STEPS])
	})

	test('starts the backends of the test job', () => {
		const job = ci.jobs['test']
		expect(job?.strategy?.matrix.postgres).toEqual([...POSTGRES_MAJORS])
		expect(job?.services?.postgres.image).toBe(postgresImage('${{ matrix.postgres }}'))
		const s3Start = job?.steps.find((step) => step.name === S3_START_STEP_NAME)?.run ?? ''
		expect(s3Start).toContain(SEAWEEDFS_IMAGE)
		for (const [name, value] of Object.entries(S3_VALUES)) expect(job?.env?.[name], name).toBe(value)
	})
})
