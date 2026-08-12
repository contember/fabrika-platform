import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireGitHubAppRecoveryLock, classifyGitHubAppState, type GitHubAppRecovery, type GitHubAppRecoveryBinding } from '../github-app-recovery'

const PEM = `-----BEGIN PRIVATE KEY-----
ZmFrZQ==
-----END PRIVATE KEY-----`

const binding: GitHubAppRecoveryBinding = {
	installation: 'test',
	projectId: 'project-1',
	controlOrigin: 'https://control.example.test',
}

const recovery: GitHubAppRecovery = {
	version: 1,
	...binding,
	owner: 'contember',
	public: false,
	app: {
		id: '123',
		slug: 'fabrika-test',
		htmlUrl: 'https://github.com/apps/fabrika-test',
		privateKeyPem: PEM,
		webhookSecret: 'webhook-secret',
	},
}

const temporaryStateHome = async (): Promise<string> => await mkdtemp(join(tmpdir(), 'fabrika-zerops-recovery-'))

const installationDirectory = (stateHome: string): string => {
	const key = createHash('sha256').update('project-1').update('\0').update('test').digest('hex').slice(0, 32)
	return join(stateHome, 'fabrika-platform', 'zerops-init', key)
}

describe('GitHub App state classifier', () => {
	test('covers the complete live/recovery state table without guessing or overwriting', () => {
		const empty = {}
		const complete = { appId: '123', privateKeyPem: PEM, webhookSecret: 'webhook-secret' }
		const matchingPartial = { privateKeyPem: PEM }
		const mismatchingPartial = { privateKeyPem: 'different' }
		expect(classifyGitHubAppState(empty, undefined)).toEqual({ kind: 'create' })
		expect(classifyGitHubAppState(empty, recovery)).toMatchObject({ kind: 'resume', credentials: recovery.app })
		expect(classifyGitHubAppState(matchingPartial, recovery)).toMatchObject({ kind: 'resume', credentials: recovery.app })
		expect(classifyGitHubAppState(matchingPartial, undefined)).toEqual({ kind: 'conflict' })
		expect(classifyGitHubAppState(mismatchingPartial, recovery)).toEqual({ kind: 'conflict' })
		expect(classifyGitHubAppState(complete, undefined)).toMatchObject({
			kind: 'preserve',
			credentials: { id: '123', privateKeyPem: PEM, webhookSecret: 'webhook-secret' },
		})
		expect(classifyGitHubAppState(complete, recovery)).toMatchObject({ kind: 'preserve', credentials: recovery.app })
		expect(classifyGitHubAppState({ ...complete, webhookSecret: 'different' }, recovery)).toEqual({ kind: 'conflict' })
	})
})

describe('GitHub App recovery store', () => {
	test('atomically persists a strict bound bundle with owner-only permissions and deletes it', async () => {
		const stateHome = await temporaryStateHome()
		try {
			const store = await acquireGitHubAppRecoveryLock({ installation: 'test', projectId: 'project-1', stateHome })
			await store.write(recovery, new AbortController().signal)
			expect(await store.read(binding)).toEqual(recovery)
			const directory = installationDirectory(stateHome)
			expect((await lstat(directory)).mode & 0o777).toBe(0o700)
			const entries = [...new Bun.Glob('recovery.json').scanSync(directory)]
			expect(entries).toHaveLength(1)
			const recoveryPath = join(directory, entries[0] ?? '')
			expect((await lstat(recoveryPath)).mode & 0o777).toBe(0o600)
			expect(await readFile(recoveryPath, 'utf8')).not.toContain('zerops-access-token')
			await expect(store.delete(binding, { ...recovery.app, webhookSecret: 'different' })).rejects.toThrow('recovery state is invalid')
			expect(await store.read(binding)).toEqual(recovery)
			await store.delete(binding, recovery.app)
			expect(await store.read(binding)).toBeUndefined()
			await store.release()
		} finally {
			await rm(stateHome, { recursive: true, force: true })
		}
	})

	test('refuses an active owner, admits only one simultaneous contender, and releases on close', async () => {
		const stateHome = await temporaryStateHome()
		const otherStateHome = await temporaryStateHome()
		try {
			const first = await acquireGitHubAppRecoveryLock({ installation: 'test', projectId: 'project-1', stateHome })
			await expect(acquireGitHubAppRecoveryLock({ installation: 'test', projectId: 'project-1', stateHome })).rejects.toThrow('already configuring')
			await expect(acquireGitHubAppRecoveryLock({ installation: 'test', projectId: 'project-1', stateHome: otherStateHome })).rejects.toThrow(
				'already configuring',
			)
			await first.release()
			const contenders = await Promise.allSettled([
				acquireGitHubAppRecoveryLock({ installation: 'test', projectId: 'project-1', stateHome }),
				acquireGitHubAppRecoveryLock({ installation: 'test', projectId: 'project-1', stateHome }),
			])
			const winners = contenders.filter((result) => result.status === 'fulfilled')
			const refused = contenders.filter((result) => result.status === 'rejected')
			expect(winners).toHaveLength(1)
			expect(refused).toHaveLength(1)
			for (const result of contenders) {
				if (result.status === 'fulfilled') await result.value.release()
			}
			const afterClose = await acquireGitHubAppRecoveryLock({ installation: 'test', projectId: 'project-1', stateHome })
			await afterClose.release()
		} finally {
			await rm(stateHome, { recursive: true, force: true })
			await rm(otherStateHome, { recursive: true, force: true })
		}
	})

	test('never overwrites a different recovery bundle', async () => {
		const stateHome = await temporaryStateHome()
		try {
			const store = await acquireGitHubAppRecoveryLock({ installation: 'test', projectId: 'project-1', stateHome })
			await store.write(recovery, new AbortController().signal)
			await store.write(recovery, new AbortController().signal)
			await expect(store.write({ ...recovery, app: { ...recovery.app, webhookSecret: 'different' } }, new AbortController().signal)).rejects.toThrow()
			expect(await store.read(binding)).toEqual(recovery)
			await store.release()
		} finally {
			await rm(stateHome, { recursive: true, force: true })
		}
	})

	test('refuses binding drift, permissive files, symlinks, and malformed recovery', async () => {
		for (const variant of ['binding', 'permissions', 'symlink', 'malformed']) {
			const stateHome = await temporaryStateHome()
			try {
				const store = await acquireGitHubAppRecoveryLock({ installation: 'test', projectId: 'project-1', stateHome })
				await store.write(recovery, new AbortController().signal)
				const directory = installationDirectory(stateHome)
				const filename = [...new Bun.Glob('recovery.json').scanSync(directory)][0]
				if (filename === undefined) throw new Error('missing recovery')
				const path = join(directory, filename)
				if (variant === 'binding') {
					await expect(store.read({ ...binding, projectId: 'other' })).rejects.toThrow('recovery state is invalid')
				} else if (variant === 'permissions') {
					await chmod(path, 0o644)
					await expect(store.read(binding)).rejects.toThrow('recovery state is invalid')
				} else if (variant === 'symlink') {
					await rm(path)
					await symlink('/tmp/not-a-recovery', path)
					await expect(store.read(binding)).rejects.toThrow('recovery state is invalid')
				} else {
					await writeFile(path, '{"version":1}', { mode: 0o600 })
					await expect(store.read(binding)).rejects.toThrow('recovery state is invalid')
				}
				await store.release()
			} finally {
				await rm(stateHome, { recursive: true, force: true })
			}
		}
	})

	test('refuses an unprotected recovery directory and honors a pre-aborted write', async () => {
		const stateHome = await temporaryStateHome()
		try {
			await mkdir(join(stateHome, 'fabrika-platform'), { mode: 0o755 })
			await expect(acquireGitHubAppRecoveryLock({ installation: 'test', projectId: 'project-1', stateHome })).rejects.toThrow(
				'recovery state is invalid',
			)
			await chmod(join(stateHome, 'fabrika-platform'), 0o700)
			const store = await acquireGitHubAppRecoveryLock({ installation: 'test', projectId: 'project-1', stateHome })
			const controller = new AbortController()
			controller.abort('private abort detail')
			const error = await store.write(recovery, controller.signal).then(() => undefined, (caught: unknown) => caught)
			expect(error).toBeInstanceOf(Error)
			expect(error instanceof Error ? error.name : '').toBe('AbortError')
			expect(error instanceof Error ? error.message : '').not.toContain('private abort detail')
			expect(await store.read(binding)).toBeUndefined()
			await store.release()
		} finally {
			await rm(stateHome, { recursive: true, force: true })
		}
	})

	test('requires an absolute state root and caps recovery input before parsing', async () => {
		await expect(acquireGitHubAppRecoveryLock({ installation: 'test', projectId: 'project-1', stateHome: 'relative/state' })).rejects.toThrow(
			'recovery state is invalid',
		)
		const stateHome = await temporaryStateHome()
		try {
			const first = await acquireGitHubAppRecoveryLock({ installation: 'test', projectId: 'project-1', stateHome })
			await first.release()
			await writeFile(join(installationDirectory(stateHome), 'recovery.json'), 'x'.repeat(72 * 1024 + 1), { mode: 0o600 })
			const second = await acquireGitHubAppRecoveryLock({ installation: 'test', projectId: 'project-1', stateHome })
			await expect(second.read(binding)).rejects.toThrow('recovery state is invalid')
			await second.release()
		} finally {
			await rm(stateHome, { recursive: true, force: true })
		}
	})

	test('refuses an absolute recovery root inside the current Git worktree', async () => {
		await expect(
			acquireGitHubAppRecoveryLock({
				installation: 'test',
				projectId: 'project-1',
				stateHome: join(process.cwd(), '.fabrika-recovery-test'),
			}),
		).rejects.toThrow('recovery state is invalid')
		const outside = await temporaryStateHome()
		try {
			const linkedRoot = join(outside, 'linked-state')
			await symlink(process.cwd(), linkedRoot)
			await expect(
				acquireGitHubAppRecoveryLock({ installation: 'test', projectId: 'project-1', stateHome: linkedRoot }),
			).rejects.toThrow('recovery state is invalid')
		} finally {
			await rm(outside, { recursive: true, force: true })
		}
	})

	test('rejects UTF-8 recovery JSON one byte above the cap before creating a file', async () => {
		const stateHome = await temporaryStateHome()
		try {
			const store = await acquireGitHubAppRecoveryLock({ installation: 'test', projectId: 'project-1', stateHome })
			const secret = '😀'.repeat(2_048)
			const withoutPadding: GitHubAppRecovery = {
				...recovery,
				app: {
					...recovery.app,
					privateKeyPem: `-----BEGIN PRIVATE KEY-----\n\n-----END PRIVATE KEY-----`,
					webhookSecret: secret,
				},
			}
			const targetBytes = 72 * 1024 + 1
			const baseBytes = new TextEncoder().encode(`${JSON.stringify(withoutPadding)}\n`).byteLength
			const oversized: GitHubAppRecovery = {
				...withoutPadding,
				app: {
					...withoutPadding.app,
					privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(targetBytes - baseBytes)}\n-----END PRIVATE KEY-----`,
				},
			}
			expect(new TextEncoder().encode(`${JSON.stringify(oversized)}\n`).byteLength).toBe(targetBytes)
			await expect(store.write(oversized, new AbortController().signal)).rejects.toThrow('recovery state is invalid')
			const directory = installationDirectory(stateHome)
			expect(await Bun.file(join(directory, 'recovery.json')).exists()).toBe(false)
			expect(await Bun.file(join(directory, 'recovery.tmp')).exists()).toBe(false)
			await store.release()
		} finally {
			await rm(stateHome, { recursive: true, force: true })
		}
	})

	test('cleans a protected stale atomic temp before recovery and leaves no secret after completed cleanup', async () => {
		const stateHome = await temporaryStateHome()
		try {
			const first = await acquireGitHubAppRecoveryLock({ installation: 'test', projectId: 'project-1', stateHome })
			await first.release()
			const temporaryPath = join(installationDirectory(stateHome), 'recovery.tmp')
			await writeFile(temporaryPath, `${JSON.stringify(recovery)}\n`, { mode: 0o600 })
			const second = await acquireGitHubAppRecoveryLock({ installation: 'test', projectId: 'project-1', stateHome })
			expect(await Bun.file(temporaryPath).exists()).toBe(false)
			await second.write(recovery, new AbortController().signal)
			await second.delete(binding, recovery.app)
			expect(await Bun.file(temporaryPath).exists()).toBe(false)
			expect(await Bun.file(join(installationDirectory(stateHome), 'recovery.json')).exists()).toBe(false)
			await second.release()
		} finally {
			await rm(stateHome, { recursive: true, force: true })
		}
	})

	test('refuses to clean an unsafe stale temp file', async () => {
		for (const variant of ['symlink', 'permissions']) {
			const stateHome = await temporaryStateHome()
			try {
				const first = await acquireGitHubAppRecoveryLock({ installation: 'test', projectId: 'project-1', stateHome })
				await first.release()
				const temporaryPath = join(installationDirectory(stateHome), 'recovery.tmp')
				if (variant === 'symlink') await symlink('/tmp/not-a-recovery', temporaryPath)
				else await writeFile(temporaryPath, `${JSON.stringify(recovery)}\n`, { mode: 0o644 })
				await expect(acquireGitHubAppRecoveryLock({ installation: 'test', projectId: 'project-1', stateHome })).rejects.toThrow(
					'recovery state is invalid',
				)
			} finally {
				await rm(stateHome, { recursive: true, force: true })
			}
		}
	})
})
