// Both application commits are ones a production build accepts: the archive Control uploads, unpacked, passes the
// checker, and on Postgres the init commands' `fabrika db migrate`, `fabrika db codegen --verify` and
// `fabrika db test-isolation`. The composed Notes container runs the workspace copy of the same files, so this is
// what ties the container's behaviour to the deployed source. The agent change passing them is what "regenerated tests
// included" means. The URL is a credential: no assertion prints it.

import { checkApplication } from '@fabrika/check'
import { dropApplicationDatabase } from '@fabrika/platform-node'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { LocalSourceFixtureKind } from '../local-source-contract'
import { applicationFixtureRoot, generateFixture } from './generate'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const CLI = join(REPO_ROOT, 'packages', 'cli', 'src', 'index.ts')
const url = process.env['FABRIKA_TEST_POSTGRES_URL'] ?? ''
if (url === '') console.warn('deployable.test.ts: the Postgres half skipped; set FABRIKA_TEST_POSTGRES_URL to run the init commands on the archive')

const staging = await mkdtemp(join(import.meta.dir, '.deployable-'))
const appIds: string[] = []

afterAll(async () => {
	await rm(staging, { recursive: true, force: true })
	if (url === '') return
	for (const appId of appIds) await dropApplicationDatabase(url, appId)
})

/** The archive as the build container receives it: the commit's files under one prefix, which the build strips. */
const unpacked = async (kind: LocalSourceFixtureKind): Promise<string> => {
	const directory = join(staging, kind)
	await mkdir(directory)
	const { archive } = await generateFixture(join(directory, 'repository'), kind)
	await writeFile(join(directory, 'application.tar.gz'), archive)
	const tar = Bun.spawn(['tar', '-xzf', join(directory, 'application.tar.gz'), '--one-top-level=source', '--strip-components=1'], {
		cwd: directory,
		stdout: 'ignore',
		stderr: 'ignore',
	})
	if ((await tar.exited) !== 0) throw new Error('the application fixture archive does not unpack')
	return join(directory, 'source')
}

for (const kind of ['application', 'agentChange'] satisfies LocalSourceFixtureKind[]) {
	const root = await unpacked(kind)
	const appId = `fixture${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`
	appIds.push(appId)

	const fabrika = async (command: string): Promise<{ code: number; output: string }> => {
		const child = Bun.spawn(['bun', CLI, 'db', command, ...(command === 'codegen' ? ['--verify'] : [])], {
			cwd: root,
			env: { PATH: process.env['PATH'] ?? '', FABRIKA_APP_ID: appId, FABRIKA_APP_DATABASE_URL: url },
			stdout: 'pipe',
			stderr: 'pipe',
		})
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
		return { code, output: `${stdout}${stderr}`.replaceAll(url, '<url>') }
	}

	describe(`the ${kind} fixture archive`, () => {
		test('passes the checker the platform build runs, generated tests and entrypoint included', async () => {
			expect(await checkApplication({ root })).toEqual([])
		})
	})

	describe.skipIf(url === '')(`the ${kind} fixture archive on Postgres`, () => {
		test("passes the init commands' steps: migrate, codegen --verify and every generated case", async () => {
			// The build installed the example's packages; its workspace install stands in for them.
			await symlink(join(applicationFixtureRoot, 'node_modules'), join(root, 'node_modules'))
			expect(await fabrika('migrate')).toMatchObject({ code: 0 })
			expect(await fabrika('codegen')).toMatchObject({ code: 0 })
			const isolation = await fabrika('test-isolation')
			expect(isolation.code).toBe(0)
			expect(isolation.output).toMatch(/^\d+ generated cases passed/m)
		}, 120_000)
	})
}
