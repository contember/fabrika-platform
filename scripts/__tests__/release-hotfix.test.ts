import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { hotfix, type HotfixRequest, type HotfixSteps, parseHotfixRequest } from '../release'

const git = (cwd: string, ...args: string[]): string => {
	const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
	if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed\n${result.stderr.toString()}`)
	return result.stdout.toString().trim()
}

const refExists = (cwd: string, ref: string): boolean => Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', ref], { cwd }).exitCode === 0

const commitFile = async (repository: string, file: string, text: string, message: string): Promise<string> => {
	await writeFile(join(repository, file), text)
	git(repository, 'add', file)
	git(repository, 'commit', '--quiet', '--message', message)
	return git(repository, 'rev-parse', 'HEAD')
}

const manifest = (version: string): string => `{\n\t"name": "fixture",\n\t"version": "${version}"\n}\n`

/** Stands in for the released source's own bump and validate, which need the whole workspace. */
const fixtureSteps = (validated: string[] = []): HotfixSteps => ({
	bump: async (worktree, tag) => {
		await writeFile(join(worktree, 'package.json'), manifest(tag.slice(1)))
	},
	validate: async (worktree, tag) => {
		expect(git(worktree, 'status', '--porcelain')).toBe('')
		const { version } = z.object({ version: z.string() }).parse(JSON.parse(await readFile(join(worktree, 'package.json'), 'utf8')))
		validated.push(`${tag} ${version}`)
	},
})

let root: string
let repository: string
let fix: string
let conflicting: string

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'fabrika-hotfix-test-'))
	repository = join(root, 'repository')
	git(root, 'init', '--quiet', '--initial-branch=main', repository)
	git(repository, 'config', 'user.name', 'Fixture')
	git(repository, 'config', 'user.email', 'fixture@example.com')
	git(repository, 'config', 'commit.gpgsign', 'false')
	git(repository, 'config', 'tag.gpgsign', 'false')
	await commitFile(repository, 'package.json', manifest('0.4.5'), 'chore: release v0.4.5')
	await commitFile(repository, 'notes.txt', 'one\n', 'docs: notes')
	git(repository, 'tag', '--annotate', 'v0.4.5', '--message', 'v0.4.5')
	await commitFile(repository, 'notes.txt', 'two\n', 'docs: notes two')
	fix = await commitFile(repository, 'fix.txt', 'fixed\n', 'fix: the hotfix')
	conflicting = await commitFile(repository, 'notes.txt', 'three\n', 'docs: notes three')
})

afterEach(async () => {
	await rm(root, { recursive: true, force: true })
})

const request = (overrides: Partial<HotfixRequest> = {}): HotfixRequest => ({
	repository,
	from: 'v0.4.5',
	tag: 'v0.4.6',
	commits: [fix],
	push: false,
	...overrides,
})

const worktreeCount = (): number =>
	git(repository, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length

describe('a hotfix release', () => {
	test("branches off the release, cherry-picks, bumps, commits and tags, leaving the caller's checkout alone", async () => {
		await writeFile(join(repository, 'notes.txt'), 'uncommitted\n')
		const head = git(repository, 'rev-parse', 'HEAD')
		const validated: string[] = []

		await hotfix(request(), fixtureSteps(validated))

		expect(git(repository, 'log', '--format=%s', 'v0.4.5..v0.4.6')).toBe('chore: release v0.4.6\nfix: the hotfix')
		expect(git(repository, 'rev-parse', 'hotfix/v0.4.6')).toBe(git(repository, 'rev-parse', 'v0.4.6^{commit}'))
		expect(git(repository, 'cat-file', '-t', 'v0.4.6')).toBe('tag')
		expect(git(repository, 'show', 'v0.4.6:package.json')).toBe(manifest('0.4.6').trim())
		expect(git(repository, 'log', '-1', '--format=%B', 'hotfix/v0.4.6~1')).toContain(`(cherry picked from commit ${fix})`)
		expect(validated).toEqual(['v0.4.6 0.4.6'])
		expect(git(repository, 'rev-parse', 'HEAD')).toBe(head)
		expect(git(repository, 'branch', '--show-current')).toBe('main')
		expect(await readFile(join(repository, 'notes.txt'), 'utf8')).toBe('uncommitted\n')
		expect(worktreeCount()).toBe(1)
	})

	test('pushes the branch and the tag only when asked', async () => {
		const origin = join(root, 'origin.git')
		git(root, 'init', '--quiet', '--bare', origin)
		git(repository, 'remote', 'add', 'origin', origin)

		await hotfix(request(), fixtureSteps())
		expect(git(origin, 'for-each-ref', '--format=%(refname)')).toBe('')

		await hotfix(request({ tag: 'v0.4.7', push: true }), fixtureSteps())
		expect(git(origin, 'for-each-ref', '--format=%(refname)').split('\n').sort()).toEqual(['refs/heads/hotfix/v0.4.7', 'refs/tags/v0.4.7'])
	})

	test('a commit that does not apply names itself and leaves no branch, tag or worktree behind', async () => {
		await expect(hotfix(request({ commits: [fix, conflicting] }), fixtureSteps())).rejects.toThrow(`${conflicting} does not apply on v0.4.5`)

		expect(refExists(repository, 'refs/heads/hotfix/v0.4.6')).toBe(false)
		expect(refExists(repository, 'refs/tags/v0.4.6')).toBe(false)
		expect(worktreeCount()).toBe(1)
	})

	test('a failed validation leaves no branch or tag, so a re-run starts clean', async () => {
		const steps: HotfixSteps = {
			...fixtureSteps(),
			validate: async () => {
				throw new Error('v0.4.6 does not match the source version')
			},
		}

		await expect(hotfix(request(), steps)).rejects.toThrow('does not match the source version')

		expect(refExists(repository, 'refs/heads/hotfix/v0.4.6')).toBe(false)
		expect(refExists(repository, 'refs/tags/v0.4.6')).toBe(false)
		expect(worktreeCount()).toBe(1)
		await hotfix(request(), fixtureSteps())
		expect(refExists(repository, 'refs/tags/v0.4.6')).toBe(true)
	})

	test('refuses a bump that leaves an untracked file the release commit would miss', async () => {
		const steps: HotfixSteps = {
			...fixtureSteps(),
			bump: async (worktree) => {
				await writeFile(join(worktree, 'generated.json'), '{}\n')
			},
		}

		await expect(hotfix(request(), steps)).rejects.toThrow('?? generated.json')
		expect(refExists(repository, 'refs/heads/hotfix/v0.4.6')).toBe(false)
	})

	test('refuses an unknown base, an existing tag and an existing branch before it creates anything', async () => {
		await expect(hotfix(request({ from: 'v0.4.4' }), fixtureSteps())).rejects.toThrow('v0.4.4 is not a tag')

		git(repository, 'branch', 'hotfix/v0.4.6', 'v0.4.5')
		await expect(hotfix(request(), fixtureSteps())).rejects.toThrow('the branch hotfix/v0.4.6 already exists')

		git(repository, 'tag', 'v0.4.6', 'v0.4.5')
		await expect(hotfix(request(), fixtureSteps())).rejects.toThrow('the tag v0.4.6 already exists')
		expect(worktreeCount()).toBe(1)
	})
})

describe('the hotfix command line', () => {
	test('takes the base release, the next tag, the commits and --push', () => {
		expect(parseHotfixRequest(['--from=v0.4.5', '--tag=v0.4.6', 'abc123', 'def456', '--push'], '/repository')).toEqual({
			repository: '/repository',
			from: 'v0.4.5',
			tag: 'v0.4.6',
			commits: ['abc123', 'def456'],
			push: true,
		})
	})

	test('needs a base, a tag and at least one commit', () => {
		expect(() => parseHotfixRequest(['--tag=v0.4.6', 'abc123'], '/repository')).toThrow('Usage: bun run release:hotfix')
		expect(() => parseHotfixRequest(['--from=v0.4.5', 'abc123'], '/repository')).toThrow('Usage: bun run release:hotfix')
		expect(() => parseHotfixRequest(['--from=v0.4.5', '--tag=v0.4.6'], '/repository')).toThrow('Usage: bun run release:hotfix')
	})

	test('refuses a tag that does not move past the base, and an unknown option', () => {
		expect(() => parseHotfixRequest(['--from=v0.4.5', '--tag=v0.4.5', 'abc123'], '/repository')).toThrow('bump must move forward')
		expect(() => parseHotfixRequest(['--from=0.4.5', '--tag=v0.4.6', 'abc123'], '/repository')).toThrow('Invalid release tag')
		expect(() => parseHotfixRequest(['--from=v0.4.5', '--tag=v0.4.6', '--dry-run', 'abc123'], '/repository')).toThrow('Unknown option: --dry-run')
	})
})
