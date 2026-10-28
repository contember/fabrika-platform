import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readMigrationBase } from '../migration-base'
import { checkMigrationHistory } from '../rules/migration-history'

const CLI = join(import.meta.dir, '..', 'cli.ts')
const FIRST = 'db/migrations/20260101120000_first.sql'
const SECOND = 'db/migrations/20260102120000_second.sql'
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const base = (files: Readonly<Record<string, string>>) => ({ ref: 'origin/main', files: new Map(Object.entries(files)) })

describe('migration-edited', () => {
	test('a migration of the base, unchanged, finds nothing; a migration only the tree holds is new', () => {
		const files = new Map([[FIRST, 'CREATE TABLE a (id TEXT);\n'], [SECOND, 'CREATE TABLE b (id TEXT);\n']])

		expect(checkMigrationHistory(files, base({ [FIRST]: 'CREATE TABLE a (id TEXT);\n' }))).toEqual([])
	})

	test('a changed comment is reported at its line', () => {
		const files = new Map([[FIRST, '-- the accounts\nCREATE TABLE a (\n\tid TEXT -- the key\n);\n']])

		const findings = checkMigrationHistory(files, base({ [FIRST]: '-- the accounts\nCREATE TABLE a (\n\tid TEXT\n);\n' }))

		expect(findings.map(({ file, line, rule }) => ({ file, line, rule }))).toEqual([{ file: FIRST, line: 3, rule: 'migration-edited' }])
		expect(findings[0]?.message).toBe(
			"'20260101120000_first.sql' differs from origin/main: a deploy refuses a migration that changed after it was applied, even in a comment",
		)
	})

	test('lines lost at the end are reported at the last line left', () => {
		const findings = checkMigrationHistory(
			new Map([[FIRST, 'CREATE TABLE a (id TEXT);']]),
			base({ [FIRST]: 'CREATE TABLE a (id TEXT);\nCREATE TABLE b (id TEXT);\n' }),
		)

		expect(findings.map(({ line }) => line)).toEqual([1])
	})

	test("a Windows checkout's line ends are not an edit", () => {
		const files = new Map([[FIRST, 'CREATE TABLE a (\r\n\tid TEXT\r\n);\r\n']])

		expect(checkMigrationHistory(files, base({ [FIRST]: 'CREATE TABLE a (\n\tid TEXT\n);\n' }))).toEqual([])
	})

	test('a deleted or renamed migration is reported under its old name', () => {
		const files = new Map([['db/migrations/20260101120000_renamed.sql', 'CREATE TABLE a (id TEXT);\n']])

		const findings = checkMigrationHistory(files, base({ [FIRST]: 'CREATE TABLE a (id TEXT);\n' }))

		expect(findings.map(({ file, line }) => ({ file, line }))).toEqual([{ file: FIRST, line: 1 }])
		expect(findings[0]?.message).toContain('was deleted or renamed')
	})
})

/** A git repository at a fresh root whose `origin/main` is the commit of `files`. */
const repository = async (files: Readonly<Record<string, string>>, options: { readonly origin?: boolean } = {}): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), 'fabrika-check-history-'))
	roots.push(root)
	await git(root, 'init', '-q', '-b', 'main')
	await commitFiles(root, files, 'base')
	if (options.origin !== false) await git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
	return root
}

const write = async (root: string, files: Readonly<Record<string, string>>): Promise<void> => {
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true })
		await writeFile(join(root, path), text)
	}
}

const commitFiles = async (root: string, files: Readonly<Record<string, string>>, message: string): Promise<void> => {
	await write(root, files)
	await git(root, 'add', '-A')
	await git(
		root,
		'-c',
		'user.name=checker',
		'-c',
		'user.email=checker@example.test',
		'-c',
		'commit.gpgsign=false',
		'commit',
		'-q',
		'--allow-empty',
		'-m',
		message,
	)
}

const git = async (root: string, ...args: string[]): Promise<string> => {
	const child = Bun.spawn(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' })
	const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
	if (code !== 0) throw new Error(`git ${args.join(' ')}: ${stderr}`)
	return stdout.trim()
}

const run = async (...args: string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> => {
	const child = Bun.spawn(['bun', CLI, ...args], { stdout: 'pipe', stderr: 'pipe' })
	const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
	return { code, stdout, stderr }
}

describe('the migrations of the base, from git', () => {
	test('reads db/migrations at the merge base, so a migration the default branch added since is not read as deleted', async () => {
		const root = await repository({ [FIRST]: 'CREATE TABLE a (id TEXT);\n', 'db/migrations/notes/readme.sql': 'nested\n' })
		await git(root, 'switch', '-q', '-c', 'feature')
		await git(root, 'switch', '-q', 'main')
		await commitFiles(root, { [SECOND]: 'CREATE TABLE b (id TEXT);\n' }, 'main moves on')
		await git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
		await git(root, 'switch', '-q', 'feature')

		const read = await readMigrationBase(root)

		expect(read).toEqual({ ref: 'origin/main', files: new Map([[FIRST, 'CREATE TABLE a (id TEXT);\n']]) })
	})

	test('an application in a subdirectory of the repository reads its own migrations, by paths relative to its root', async () => {
		const root = await repository({ [`apps/crm/${FIRST}`]: 'CREATE TABLE a (id TEXT);\n', [FIRST]: 'the repository root\n' })

		expect(await readMigrationBase(join(root, 'apps/crm'))).toEqual({ ref: 'origin/main', files: new Map([[FIRST, 'CREATE TABLE a (id TEXT);\n']]) })
	})

	test('outside a git work tree there is nothing to compare with; without a default branch, why', async () => {
		const plain = await mkdtemp(join(tmpdir(), 'fabrika-check-plain-'))
		roots.push(plain)
		const unpushed = await repository({ [FIRST]: 'CREATE TABLE a (id TEXT);\n' }, { origin: false })

		expect(await readMigrationBase(plain)).toBeNull()
		expect(await readMigrationBase(unpushed)).toEqual({
			skipped: 'no origin/HEAD, origin/main or origin/master to compare the migrations with; pass --base <ref>',
		})
		expect(await readMigrationBase(unpushed, 'main')).toEqual({ ref: 'main', files: new Map([[FIRST, 'CREATE TABLE a (id TEXT);\n']]) })
		expect(await readMigrationBase(unpushed, '--output=x')).toEqual({ skipped: '--output=x names no commit' })
	})

	test('fabrika-check refuses an uncommitted edit of a merged migration and leaves a new one alone', async () => {
		const root = await repository({ [FIRST]: 'CREATE TABLE a (id TEXT);\n' })
		await write(root, { [FIRST]: '-- the accounts\nCREATE TABLE a (id TEXT);\n', [SECOND]: 'CREATE TABLE b (id TEXT);\n' })

		const result = await run(root)

		expect(result.code).toBe(1)
		expect(result.stdout).toContain(`${FIRST}:1:1 migration-edited '20260101120000_first.sql' differs from origin/main`)
		expect(result.stdout).not.toContain(SECOND)
	})

	test('fabrika-check says when it could not compare, and fails on a --base it cannot read', async () => {
		const root = await repository({ [FIRST]: 'CREATE TABLE a (id TEXT);\n' }, { origin: false })

		const skipped = await run(root)
		const refused = await run('--base', 'origin/nowhere', root)

		expect(skipped.stderr).toContain('fabrika-check: migration-edited did not run: no origin/HEAD, origin/main or origin/master')
		expect(refused.code).toBe(2)
		expect(refused.stderr).toContain('fabrika-check: cannot compare the migrations with origin/nowhere: origin/nowhere names no commit')
	})
})
