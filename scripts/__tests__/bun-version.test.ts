// `.bun-version` is the one Bun release fabrika is built, tested and released with. Every place that
// installs Bun either reads that file or is checked against it here, so bumping Bun is a one-line change
// that fails loudly wherever a copy was missed.

import { describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')

const workflowSchema = z.object({
	jobs: z.record(z.object({ steps: z.array(z.object({ uses: z.string().optional(), with: z.record(z.unknown()).optional() })).optional() })),
})

const readRepoFile = async (path: string): Promise<string> => await Bun.file(resolve(REPO_ROOT, path)).text()

describe('the Bun version', () => {
	test('.bun-version names one exact release', async () => {
		expect(await readRepoFile('.bun-version')).toMatch(/^\d+\.\d+\.\d+\n$/)
	})

	test("every setup-bun step of this repository's CI reads .bun-version", async () => {
		const directory = resolve(REPO_ROOT, '.github/workflows')
		let setups = 0
		for (const name of await readdir(directory)) {
			const workflow = workflowSchema.parse(Bun.YAML.parse(await Bun.file(resolve(directory, name)).text()))
			for (const [job, { steps }] of Object.entries(workflow.jobs)) {
				for (const step of steps ?? []) {
					if (step.uses?.startsWith('oven-sh/setup-bun@') !== true) continue
					setups += 1
					expect(step.with, `${name} job ${job}`).toEqual({ 'bun-version-file': '.bun-version' })
				}
			}
		}
		expect(setups).toBeGreaterThan(0)
	})

	test('the local stack runs the same Bun image', async () => {
		const version = (await readRepoFile('.bun-version')).trim()
		for (const path of ['packages/local-stack/compose.yaml', 'packages/local-stack/app-image/Dockerfile']) {
			const images = [...(await readRepoFile(path)).matchAll(/oven\/bun:([^\s]+)/g)].map((match) => match[1])
			expect(images.length, path).toBeGreaterThan(0)
			for (const image of images) {
				expect(image, path).toBe(`${version}-alpine`)
			}
		}
	})

	test('the dev sandbox base image runs the same Bun, pinned by digest', async () => {
		const version = (await readRepoFile('.bun-version')).trim()
		const dockerfile = await readRepoFile('packages/provider-zerops/sandbox/Dockerfile')
		const images = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((match) => match[1])
		expect(images).toHaveLength(1)
		expect(images[0]).toMatch(new RegExp(`^oven/bun:${version.replaceAll('.', '\\.')}-alpine@sha256:[0-9a-f]{64}$`))
	})

	test('the runner image installs the release .bun-version names', async () => {
		const dockerfile = await readRepoFile('packages/runner-container/Dockerfile')
		expect(dockerfile).toContain('COPY .bun-version /tmp/.bun-version')
		expect(dockerfile).toContain('bun.com/install | bash -s "bun-v$(tr -d \'[:space:]\' < /tmp/.bun-version)"')
	})
})
