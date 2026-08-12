import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const RECOVERY_DIRECTORY_MODE = 0o700
const RECOVERY_FILE_MODE = 0o600
const APP_ID_PATTERN = /^[1-9][0-9]*$/
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/
const PEM_PATTERN = /^-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+-----END (?:RSA )?PRIVATE KEY-----\s*$/
const RECOVERY_ERROR = 'GitHub App recovery state is invalid; inspect the protected recovery file before continuing'
const LOCK_ERROR = 'another Zerops init is already configuring this installation'
const LOCK_PORT_START = 49_152
const LOCK_PORT_COUNT = 65_536 - LOCK_PORT_START
const RECOVERY_FILE_SIZE_LIMIT = 72 * 1024
const RECOVERY_TEMP_NAME = 'recovery.tmp'

export interface GitHubAppRecoveryBinding {
	readonly installation: string
	readonly projectId: string
	readonly controlOrigin: string
}

export interface GitHubAppCredentials {
	readonly id: string
	readonly slug: string
	readonly htmlUrl: string
	readonly privateKeyPem: string
	readonly webhookSecret: string
}

export interface GitHubAppRecovery extends GitHubAppRecoveryBinding {
	readonly version: 1
	readonly owner: string
	readonly public: boolean
	readonly app: GitHubAppCredentials
}

export interface LiveGitHubAppState {
	readonly appId?: string
	readonly privateKeyPem?: string
	readonly webhookSecret?: string
}

export type GitHubAppStateDecision =
	| { readonly kind: 'create' }
	| { readonly kind: 'resume'; readonly credentials: GitHubAppCredentials }
	| { readonly kind: 'preserve'; readonly credentials: GitHubAppCredentials }
	| { readonly kind: 'conflict' }

export interface GitHubAppRecoveryLock {
	hasRecovery(): Promise<boolean>
	read(binding: GitHubAppRecoveryBinding): Promise<GitHubAppRecovery | undefined>
	write(recovery: GitHubAppRecovery, signal: AbortSignal): Promise<void>
	delete(binding: GitHubAppRecoveryBinding, credentials: GitHubAppCredentials): Promise<void>
	release(): Promise<void>
}

export interface GitHubAppRecoveryStoreOptions {
	readonly installation: string
	readonly projectId: string
	readonly stateHome?: string
}

const field = (value: unknown, name: string): unknown =>
	typeof value === 'object' && value !== null && !Array.isArray(value) ? Reflect.get(value, name) : undefined

const exactKeys = (value: unknown, expected: readonly string[]): boolean => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
}

const validOrigin = (value: string): boolean => {
	let parsed: URL
	try {
		parsed = new URL(value)
	} catch {
		return false
	}
	return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.port === '' && parsed.pathname === '/'
		&& parsed.search === '' && parsed.hash === '' && parsed.origin === value
}

const validHtmlUrl = (value: string, slug: string): boolean => {
	let parsed: URL
	try {
		parsed = new URL(value)
	} catch {
		return false
	}
	return parsed.protocol === 'https:' && parsed.hostname === 'github.com' && parsed.port === '' && parsed.username === '' && parsed.password === ''
		&& parsed.pathname === `/apps/${slug}` && parsed.search === '' && parsed.hash === ''
}

const validSecret = (value: string): boolean =>
	value.length > 0 && value.length <= 4096 && ![...value].some((character) => {
		const code = character.charCodeAt(0)
		return code < 32 || code === 127
	})

const decodeRecovery = (value: unknown): GitHubAppRecovery => {
	if (!exactKeys(value, ['version', 'installation', 'projectId', 'owner', 'controlOrigin', 'public', 'app'])) throw new Error(RECOVERY_ERROR)
	const version = field(value, 'version')
	const installation = field(value, 'installation')
	const projectId = field(value, 'projectId')
	const owner = field(value, 'owner')
	const controlOrigin = field(value, 'controlOrigin')
	const isPublic = field(value, 'public')
	const app = field(value, 'app')
	if (
		version !== 1 || typeof installation !== 'string' || installation === '' || installation.length > 128
		|| typeof projectId !== 'string' || projectId === '' || projectId.length > 128
		|| typeof owner !== 'string' || !OWNER_PATTERN.test(owner) || typeof controlOrigin !== 'string' || !validOrigin(controlOrigin)
		|| typeof isPublic !== 'boolean' || !exactKeys(app, ['id', 'slug', 'htmlUrl', 'privateKeyPem', 'webhookSecret'])
	) throw new Error(RECOVERY_ERROR)
	const id = field(app, 'id')
	const slug = field(app, 'slug')
	const htmlUrl = field(app, 'htmlUrl')
	const privateKeyPem = field(app, 'privateKeyPem')
	const webhookSecret = field(app, 'webhookSecret')
	if (
		typeof id !== 'string' || !APP_ID_PATTERN.test(id) || id.length > 32 || typeof slug !== 'string' || !APP_SLUG_PATTERN.test(slug)
		|| typeof htmlUrl !== 'string' || !validHtmlUrl(htmlUrl, slug) || typeof privateKeyPem !== 'string'
		|| privateKeyPem.length > 64 * 1024 || !PEM_PATTERN.test(privateKeyPem) || typeof webhookSecret !== 'string' || !validSecret(webhookSecret)
	) throw new Error(RECOVERY_ERROR)
	return {
		version: 1,
		installation,
		projectId,
		owner,
		controlOrigin,
		public: isPublic,
		app: { id, slug, htmlUrl, privateKeyPem, webhookSecret },
	}
}

const sameBinding = (recovery: GitHubAppRecovery, binding: GitHubAppRecoveryBinding): boolean =>
	recovery.installation === binding.installation && recovery.projectId === binding.projectId
	&& recovery.controlOrigin === binding.controlOrigin

const complete = (live: LiveGitHubAppState): live is Required<LiveGitHubAppState> =>
	live.appId !== undefined && live.privateKeyPem !== undefined && live.webhookSecret !== undefined

const liveMatches = (live: LiveGitHubAppState, credentials: GitHubAppCredentials): boolean =>
	(live.appId === undefined || live.appId === credentials.id)
	&& (live.privateKeyPem === undefined || live.privateKeyPem === credentials.privateKeyPem)
	&& (live.webhookSecret === undefined || live.webhookSecret === credentials.webhookSecret)

export const classifyGitHubAppState = (
	live: LiveGitHubAppState,
	recovery: GitHubAppRecovery | undefined,
): GitHubAppStateDecision => {
	const present = [live.appId, live.privateKeyPem, live.webhookSecret].filter((value) => value !== undefined).length
	if (recovery !== undefined && !liveMatches(live, recovery.app)) return { kind: 'conflict' }
	if (complete(live)) {
		return {
			kind: 'preserve',
			credentials: recovery?.app ?? {
				id: live.appId,
				slug: '',
				htmlUrl: '',
				privateKeyPem: live.privateKeyPem,
				webhookSecret: live.webhookSecret,
			},
		}
	}
	if (recovery !== undefined) return { kind: 'resume', credentials: recovery.app }
	return present === 0 ? { kind: 'create' } : { kind: 'conflict' }
}

const errorCode = (error: unknown): string | undefined => {
	const value = field(error, 'code')
	return typeof value === 'string' ? value : undefined
}

const abortError = (): Error => {
	const error = new Error('GitHub App recovery write was aborted')
	error.name = 'AbortError'
	return error
}

const throwIfAborted = (signal: AbortSignal): void => {
	if (signal.aborted) throw abortError()
}

const fsyncDirectory = async (directory: string): Promise<void> => {
	let handle: FileHandle | undefined
	try {
		handle = await open(directory, 'r')
		await handle.sync()
	} catch (error) {
		if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(errorCode(error) ?? '')) throw error
	} finally {
		await handle?.close()
	}
}

const requireProtectedDirectory = async (directory: string): Promise<void> => {
	await mkdir(directory, { recursive: true, mode: RECOVERY_DIRECTORY_MODE })
	const info = await lstat(directory)
	if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== RECOVERY_DIRECTORY_MODE) throw new Error(RECOVERY_ERROR)
}

const requireProtectedFile = async (path: string): Promise<boolean> => {
	let info: Stats
	try {
		info = await lstat(path)
	} catch (error) {
		if (errorCode(error) === 'ENOENT') return false
		throw new Error(RECOVERY_ERROR)
	}
	if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== RECOVERY_FILE_MODE) throw new Error(RECOVERY_ERROR)
	return true
}

const findGitWorktree = async (start: string): Promise<string | undefined> => {
	let directory = resolve(start)
	for (;;) {
		const marker = join(directory, '.git')
		try {
			const info = await lstat(marker)
			if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error(RECOVERY_ERROR)
			return directory
		} catch (error) {
			if (errorCode(error) !== 'ENOENT') throw new Error(RECOVERY_ERROR)
		}
		const parent = dirname(directory)
		if (parent === directory) return undefined
		directory = parent
	}
}

const inside = (parent: string, candidate: string): boolean => {
	const path = relative(parent, candidate)
	return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

const requireNoSymlinkComponents = async (path: string): Promise<void> => {
	const components: string[] = []
	let component = resolve(path)
	for (;;) {
		components.push(component)
		const parent = dirname(component)
		if (parent === component) break
		component = parent
	}
	for (const candidate of components.reverse()) {
		try {
			const info = await lstat(candidate)
			if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(RECOVERY_ERROR)
		} catch (error) {
			if (errorCode(error) === 'ENOENT') return
			throw new Error(RECOVERY_ERROR)
		}
	}
}

const sameRecovery = (left: GitHubAppRecovery, right: GitHubAppRecovery): boolean => JSON.stringify(left) === JSON.stringify(right)

const stateRoot = (stateHome?: string): string => {
	if (stateHome !== undefined) return stateHome
	const configured = Reflect.get(process.env, 'XDG_STATE_HOME')
	return typeof configured === 'string' ? configured : join(homedir(), '.local', 'state')
}

const acquireProcessLock = (key: string): () => void => {
	const offset = Number.parseInt(key.slice(0, 8), 16) % LOCK_PORT_COUNT
	try {
		const listener = Bun.listen({
			hostname: '127.0.0.1',
			port: LOCK_PORT_START + offset,
			socket: { data() {} },
		})
		return () => listener.stop(true)
	} catch {
		throw new Error(LOCK_ERROR)
	}
}

/** Open one exclusive init session. Recovery files live outside the repository and contain no deploy token. */
export const acquireGitHubAppRecoveryLock = async (options: GitHubAppRecoveryStoreOptions): Promise<GitHubAppRecoveryLock> => {
	const configuredRoot = stateRoot(options.stateHome)
	if (!isAbsolute(configuredRoot)) throw new Error(RECOVERY_ERROR)
	const root = resolve(configuredRoot)
	await requireNoSymlinkComponents(root)
	const worktree = await findGitWorktree(process.cwd())
	if (worktree !== undefined && inside(worktree, root)) throw new Error(RECOVERY_ERROR)
	const lockKey = createHash('sha256').update(options.projectId).update('\0').update(options.installation).digest('hex')
	const key = lockKey.slice(0, 32)
	const releaseProcessLock = acquireProcessLock(lockKey)
	const platformDirectory = join(root, 'fabrika-platform')
	const initDirectory = join(platformDirectory, 'zerops-init')
	const directory = join(initDirectory, key)
	try {
		for (const protectedDirectory of [platformDirectory, initDirectory, directory]) await requireProtectedDirectory(protectedDirectory)
		await requireNoSymlinkComponents(root)
	} catch (error) {
		releaseProcessLock()
		throw error
	}
	const recoveryPath = join(directory, 'recovery.json')
	const temporaryPath = join(directory, RECOVERY_TEMP_NAME)
	try {
		if (await requireProtectedFile(temporaryPath)) {
			await unlink(temporaryPath)
			await fsyncDirectory(directory)
		}
	} catch (error) {
		releaseProcessLock()
		throw error
	}
	let released = false
	const readRecovery = async (binding: GitHubAppRecoveryBinding): Promise<GitHubAppRecovery | undefined> => {
		if (!(await requireProtectedFile(recoveryPath))) return undefined
		if ((await lstat(recoveryPath)).size > RECOVERY_FILE_SIZE_LIMIT) throw new Error(RECOVERY_ERROR)
		let parsed: unknown
		try {
			parsed = JSON.parse(await readFile(recoveryPath, 'utf8'))
		} catch {
			throw new Error(RECOVERY_ERROR)
		}
		const recovery = decodeRecovery(parsed)
		if (!sameBinding(recovery, binding)) throw new Error(RECOVERY_ERROR)
		return recovery
	}
	return {
		hasRecovery: () => requireProtectedFile(recoveryPath),
		read: readRecovery,
		async write(recovery, signal) {
			throwIfAborted(signal)
			const validated = decodeRecovery(recovery)
			const serialized = `${JSON.stringify(validated)}\n`
			if (new TextEncoder().encode(serialized).byteLength > RECOVERY_FILE_SIZE_LIMIT) throw new Error(RECOVERY_ERROR)
			await requireProtectedDirectory(directory)
			if (await requireProtectedFile(recoveryPath)) {
				const existing = await readRecovery(validated)
				if (existing === undefined || !sameRecovery(existing, validated)) throw new Error(RECOVERY_ERROR)
				return
			}
			let temporary: FileHandle | undefined
			try {
				temporary = await open(temporaryPath, 'wx', RECOVERY_FILE_MODE)
				await temporary.writeFile(serialized, { encoding: 'utf8', signal })
				throwIfAborted(signal)
				await temporary.sync()
				throwIfAborted(signal)
				await temporary.close()
				temporary = undefined
				if (await requireProtectedFile(recoveryPath)) throw new Error(RECOVERY_ERROR)
				await rename(temporaryPath, recoveryPath)
				await fsyncDirectory(directory)
			} catch (error) {
				await temporary?.close().catch(() => {})
				await unlink(temporaryPath).catch(() => {})
				if (signal.aborted) throw abortError()
				throw new Error('GitHub App recovery state could not be written')
			}
		},
		async delete(binding, credentials) {
			const recovery = await readRecovery(binding)
			if (recovery !== undefined) {
				if (!sameRecovery(recovery, { ...recovery, app: credentials })) throw new Error(RECOVERY_ERROR)
				await unlink(recoveryPath)
			}
			if (await requireProtectedFile(temporaryPath)) await unlink(temporaryPath)
			await fsyncDirectory(directory)
		},
		async release() {
			if (released) return
			released = true
			releaseProcessLock()
		},
	}
}
