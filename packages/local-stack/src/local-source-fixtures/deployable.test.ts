// The application fixture is a commit a production build accepts: the archive Control uploads, unpacked, passes the
// checker, and on Postgres the start script's `fabrika db migrate`, `fabrika db codegen --verify` and
// `fabrika db test-isolation`. The composed Notes container runs the workspace copy of the same files, so this is
// what ties the container's behaviour to the deployed source. The URL is a credential: no assertion prints it.

import { checkApplication } from '@fabrika/check'
import { applicationDatabaseSchema } from '@fabrika/platform-node'
import { SQL } from 'bun'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { generateFixture } from './generate'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const CLI = join(REPO_ROOT, 'packages', 'cli', 'src', 'index.ts')
const url = process.env['FABRIKA_TEST_POSTGRES_URL'] ?? ''
if (url === '') console.warn('deployable.test.ts: the Postgres half skipped; set FABRIKA_TEST_POSTGRES_URL to run the start script on the archive')

const staging = await mkdtemp(join(import.meta.dir, '.deployable-'))
const appId = `fixture${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`

afterAll(async () => {
	await rm(staging, { recursive: true, force: true })
	if (url === '') return
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	await sql.unsafe(`DROP SCHEMA IF EXISTS ${applicationDatabaseSchema(appId)} CASCADE`)
	await sql.close()
})

/** The archive as the build container receives it: the commit's files under one prefix, which the build strips. */
const unpacked = async (): Promise<string> => {
	const { archive } = await generateFixture(join(staging, 'repository'), 'application')
	const root = join(staging, 'source')
	await writeFile(join(staging, 'application.tar.gz'), archive)
	const tar = Bun.spawn(['tar', '-xzf', join(staging, 'application.tar.gz'), '--one-top-level=source', '--strip-components=1'], {
		cwd: staging,
		stdout: 'ignore',
		stderr: 'ignore',
	})
	if ((await tar.exited) !== 0) throw new Error('the application fixture archive does not unpack')
	return root
}

const root = await unpacked()

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

describe('the application fixture archive', () => {
	test('passes the checker the platform build runs, generated tests and entrypoint included', async () => {
		expect(await checkApplication({ root })).toEqual([])
	})
})

describe.skipIf(url === '')('the application fixture archive on Postgres', () => {
	test("passes the start script's steps: migrate, codegen --verify and every generated case", async () => {
		// The build installed the packages; the workspace's own stand in for them.
		await symlink(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'))
		expect(await fabrika('migrate')).toMatchObject({ code: 0 })
		expect(await fabrika('codegen')).toMatchObject({ code: 0 })
		const isolation = await fabrika('test-isolation')
		expect(isolation.code).toBe(0)
		expect(isolation.output).toMatch(/^\d+ generated cases passed/m)
	}, 120_000)
})
