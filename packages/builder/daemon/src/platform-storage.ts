import { createHash, randomUUID } from 'node:crypto'
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import {
	type BuilderDeploymentState,
	type BuilderProjectConfig,
	type BuilderProjectConnection,
	parseBuilderDeploymentState,
	parseBuilderProjectConfig,
	parseBuilderProjectConnection,
} from '../../shared'

export class PlatformError extends Error {}

export function within(root: string, path: string): boolean {
	const rel = relative(root, path)
	return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

export function record(value: unknown): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PlatformError('Invalid stored or upstream data')
	return Object.fromEntries(Object.entries(value))
}

export function text(value: unknown): string {
	if (typeof value !== 'string' || !value || value.length > 8192) throw new PlatformError('Invalid stored or upstream data')
	return value
}

export function integer(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new PlatformError('Invalid stored or upstream data')
	return value
}

export function noSymlinks(path: string): void {
	const absolute = resolve(path)
	let current = parse(absolute).root
	for (const component of relative(current, absolute).split(sep).filter(Boolean)) {
		current = join(current, component)
		if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new PlatformError('Symlinks are not allowed in platform storage paths')
	}
}

function privateDirectory(path: string, create: boolean): void {
	noSymlinks(path)
	if (create) mkdirSync(path, { recursive: true, mode: 0o700 })
	const stat = lstatSync(path, { throwIfNoEntry: false })
	if (!stat) return
	if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
		throw new PlatformError('Platform storage must be an owner-only directory')
	}
}

function readJson(path: string, privateFile = false): unknown {
	noSymlinks(path)
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const stat = fstatSync(fd)
		if (!stat.isFile() || stat.size > 1024 * 1024 || stat.nlink !== 1) throw new PlatformError('Invalid platform storage file')
		if (privateFile && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))) {
			throw new PlatformError('Credential file must be owner-only')
		}
		return JSON.parse(readFileSync(fd, 'utf8'))
	} finally {
		closeSync(fd)
	}
}

function writeJson(path: string, value: unknown): void {
	noSymlinks(path)
	const temp = join(dirname(path), `.write-${randomUUID()}`)
	try {
		writeFileSync(temp, `${JSON.stringify(value, null, '\t')}\n`, { flag: 'wx', mode: 0o600 })
		renameSync(temp, path)
	} finally {
		rmSync(temp, { force: true })
	}
}

export interface ProjectRecord {
	sessionId: string
	projectRoot: string
	deployment: BuilderDeploymentState | null
	recoveryRequired: boolean
}

export interface StoredCredential {
	connection: BuilderProjectConnection
	token: string
	expiresAt: number
}

export class PlatformStorage {
	constructor(readonly stateDir: string, readonly credentialDir: string, readonly dataDir: string) {}

	assertProjectRoot(path: string, allowMissing = false): string {
		noSymlinks(path)
		const root = allowMissing && !existsSync(path) ? resolve(path) : realpathSync(path)
		if (
			(existsSync(root) && !lstatSync(root).isDirectory()) || within(root, homedir()) || within(root, resolve(this.credentialDir))
			|| within(root, resolve(this.dataDir))
			|| within(root, resolve(this.stateDir))
		) {
			throw new PlatformError('Project root must not contain home or daemon storage')
		}
		if (within(resolve(this.credentialDir), root) || within(resolve(this.stateDir), root)) {
			throw new PlatformError('Project root cannot be daemon storage')
		}
		return root
	}

	private path(dir: string, id: string, create = false): string {
		privateDirectory(dir, create)
		const path = join(dir, `${createHash('sha256').update(id).digest('hex')}.json`)
		noSymlinks(path)
		return path
	}

	project(id: string): ProjectRecord | null {
		const path = this.path(this.stateDir, id)
		if (!existsSync(path)) return null
		const project = this.readProject(path)
		if (project.sessionId !== id) throw new PlatformError('Project registration mismatch')
		this.assertProjectRoot(project.projectRoot)
		return project
	}

	projects(): ProjectRecord[] {
		privateDirectory(this.stateDir, false)
		if (!existsSync(this.stateDir)) return []
		return readdirSync(this.stateDir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map((name) => {
			const path = join(this.stateDir, name)
			const project = this.readProject(path)
			if (this.path(this.stateDir, project.sessionId) !== path) throw new PlatformError('Project registration mismatch')
			return project
		})
	}

	private readProject(path: string): ProjectRecord {
		const value = record(readJson(path, true))
		const recoveryRequired = value['recoveryRequired']
		if (typeof recoveryRequired !== 'boolean') throw new PlatformError('Invalid project recovery state')
		return {
			sessionId: text(value['sessionId']),
			projectRoot: text(value['projectRoot']),
			deployment: value['deployment'] === null ? null : parseBuilderDeploymentState(value['deployment']),
			recoveryRequired,
		}
	}

	saveProject(project: ProjectRecord): void {
		this.assertProjectRoot(project.projectRoot)
		writeJson(this.path(this.stateDir, project.sessionId, true), project)
	}

	config(project: ProjectRecord): BuilderProjectConfig {
		const config = parseBuilderProjectConfig(readJson(join(project.projectRoot, '.fabrika', 'config.json')))
		if (config.sessionId !== project.sessionId) throw new PlatformError('Project config session does not match registration')
		return config
	}

	saveConfig(project: ProjectRecord, config: BuilderProjectConfig): void {
		this.config(project)
		writeJson(join(project.projectRoot, '.fabrika', 'config.json'), parseBuilderProjectConfig(config))
	}

	credential(id: string): StoredCredential | null {
		const path = this.path(this.credentialDir, id)
		if (!existsSync(path)) return null
		const value = record(readJson(path, true))
		return { connection: parseBuilderProjectConnection(value['connection']), token: text(value['token']), expiresAt: integer(value['expiresAt']) }
	}

	saveCredential(id: string, credential: StoredCredential): void {
		writeJson(this.path(this.credentialDir, id, true), credential)
	}

	removeCredential(id: string): void {
		const path = this.path(this.credentialDir, id)
		noSymlinks(path)
		rmSync(path, { force: true })
	}

	artifact(root: string, path: string): string {
		const safeRoot = this.assertProjectRoot(root)
		const requested = resolve(safeRoot, path)
		if (!within(safeRoot, requested)) throw new PlatformError('Artifact path is outside the project')
		const target = realpathSync(requested)
		if (!within(safeRoot, target) || within(resolve(this.credentialDir), target) || within(resolve(this.stateDir), target)) {
			throw new PlatformError('Artifact path is outside the project')
		}
		return target
	}

	assertPublicFile(path: string): void {
		const target = realpathSync(path)
		if (within(resolve(this.credentialDir), target) || within(resolve(this.stateDir), target)) {
			throw new PlatformError('Daemon storage cannot be exposed as project content')
		}
		if (lstatSync(target).nlink !== 1) throw new PlatformError('Hard-linked project content is not supported')
	}
}
