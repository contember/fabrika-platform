import {
	createZeropsArtifactSourceDescriptor,
	ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES,
	type ZeropsArtifactSourceDescriptor,
} from '@fabrika/provider-zerops'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface PreparedPlatformSource {
	commitSha: string
	descriptor: ZeropsArtifactSourceDescriptor
	archivePath: string
	dispose(): Promise<void>
}

// The caller must separately establish that the executing CLI belongs to this checkout.
export async function preparePlatformSource(sourceDir: string, signal: AbortSignal): Promise<PreparedPlatformSource> {
	signal.throwIfAborted()
	const root = await realpath(sourceDir)
	const git = (args: string[], cwd = root, env: Record<string, string> = {}) => runGit(cwd, args, signal, env)
	const topLevel = (await git(['rev-parse', '--show-toplevel'])).trimEnd()
	if (await realpath(topLevel) !== root) throw new Error('Platform source directory must be the Git repository root')
	const commitSha = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commitSha)) throw new Error('Invalid platform source commit')
	const tree = await git(['ls-tree', '-rz', commitSha])
	if (tree.split('\0').some((entry) => entry.startsWith('160000 '))) throw new Error('Platform source submodules are not supported')
	const tracked = await git(['ls-files', '-v', '-z'])
	if (tracked.split('\0').some((entry) => entry !== '' && !entry.startsWith('H '))) {
		throw new Error('Platform source requires a full checkout without skip-worktree or assume-unchanged entries')
	}
	await git(['diff', '--no-ext-diff', '--no-textconv', '--quiet', '--cached', commitSha, '--'])
	await git(['diff', '--no-ext-diff', '--no-textconv', '--quiet', '--'])
	const descriptorEntry = await git(['ls-tree', '-z', commitSha, '--', 'zerops.yaml'])
	if (!/^100(?:644|755) blob [a-f0-9]+\tzerops\.yaml\0$/.test(descriptorEntry)) {
		throw new Error('Platform source requires a regular root zerops.yaml')
	}
	const size = Number((await git(['cat-file', '-s', `${commitSha}:zerops.yaml`])).trim())
	if (!Number.isSafeInteger(size) || size <= 0 || size > ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES) {
		throw new Error('Platform source zerops.yaml is empty or exceeds the descriptor size limit')
	}
	const contents = await git(['show', `${commitSha}:zerops.yaml`])
	const descriptor = await createZeropsArtifactSourceDescriptor(contents)
	const objectDirectory = (await git(['rev-parse', '--path-format=absolute', '--git-path', 'objects'])).trimEnd()
	const objectFormat = (await git(['rev-parse', '--show-object-format'])).trim()
	if (objectFormat !== 'sha1' && objectFormat !== 'sha256') throw new Error('Unsupported Git object format')
	signal.throwIfAborted()
	const temporary = await mkdtemp(join(tmpdir(), 'fabrika-platform-source-'))
	const dispose = () => rm(temporary, { recursive: true, force: true })
	try {
		const repository = join(temporary, 'repository.git')
		await git(['init', '--bare', `--object-format=${objectFormat}`, '--template=', repository], temporary)
		// Override nested committed attributes too: archive must neither omit nor transform Git blob bytes.
		await mkdir(join(repository, 'info'))
		await writeFile(join(repository, 'info', 'attributes'), '* -export-ignore -export-subst -text -eol -crlf -ident -working-tree-encoding -filter\n')
		const archivePath = join(temporary, 'source.tar.gz')
		await git(['archive', '--format=tar.gz', `--output=${archivePath}`, commitSha], repository, {
			GIT_OBJECT_DIRECTORY: objectDirectory,
		})
		signal.throwIfAborted()
		const archived = (await new Bun.Archive(await Bun.file(archivePath).arrayBuffer()).files('zerops.yaml')).get('zerops.yaml')
		if (!archived || archived.size !== size) throw new Error('Archived platform descriptor differs from the committed descriptor')
		const archivedContents = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await archived.arrayBuffer())
		if (archivedContents !== contents) throw new Error('Archived platform descriptor differs from the committed descriptor')
		signal.throwIfAborted()
		return { commitSha, descriptor, archivePath, dispose }
	} catch (error) {
		await dispose()
		throw error
	}
}

// installation-init capture inherits stderr and has no cancellation; source commands must do neither.
async function runGit(cwd: string, args: string[], signal: AbortSignal, extraEnv: Record<string, string>): Promise<string> {
	signal.throwIfAborted()
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))
	try {
		const child = Bun.spawn(['git', '-c', 'core.attributesFile=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
			cwd,
			env: {
				...env,
				GIT_CONFIG_NOSYSTEM: '1',
				GIT_CONFIG_GLOBAL: '/dev/null',
				GIT_ATTR_NOSYSTEM: '1',
				GIT_NO_REPLACE_OBJECTS: '1',
				GIT_NO_LAZY_FETCH: '1',
				...extraEnv,
			},
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'ignore',
		})
		const abort = () => child.kill()
		signal.addEventListener('abort', abort, { once: true })
		try {
			if (signal.aborted) abort()
			const [bytes, exitCode] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited])
			signal.throwIfAborted()
			if (exitCode !== 0) throw new Error('Git source check failed')
			return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
		} finally {
			signal.removeEventListener('abort', abort)
			child.kill()
			await child.exited
		}
	} catch {
		signal.throwIfAborted()
		throw new Error('Git platform source preparation failed; verify a clean tracked index and worktree and valid UTF-8 source metadata')
	}
}
