import type { AppDto } from '@fabrika/control-contract'
import {
	type FabrikaManifest,
	normalizeZeropsSourceRepository,
	parseFabrikaManifest,
	verifyZeropsArtifactSourceDescriptor,
} from '@fabrika/provider-zerops'
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { noSymlinks, PlatformError } from './platform-storage'

async function git(root: string, args: string[], signal: AbortSignal): Promise<string> {
	const child = Bun.spawn(['git', '-C', root, ...args], {
		env: gitEnvironment(process.env),
		stdout: 'pipe',
		stderr: 'ignore',
		stdin: 'ignore',
		signal,
		timeout: 60_000,
	})
	const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
	if (code !== 0 || output.length > 1024 * 1024) throw new PlatformError('Git verification failed; check the repository and your Git credentials')
	return output.trim()
}

export function repositoryIdentity(url: string): string {
	const ssh = /^git@github\.com:([^\s]+)$/.exec(url) ?? /^ssh:\/\/git@github\.com\/([^\s]+)$/.exec(url)
	try {
		const repository = normalizeZeropsSourceRepository(ssh ? `https://github.com/${ssh[1]}` : url)
		return `${repository.owner}/${repository.name}`
	} catch {
		throw new PlatformError('Source must identify the approved GitHub repository')
	}
}

export async function verifySource(root: string, app: AppDto, signal: AbortSignal): Promise<string> {
	if (realpathSync(await git(root, ['rev-parse', '--show-toplevel'], signal)) !== root) {
		throw new PlatformError('Project must be the Git repository root')
	}
	if (app.workerDir && app.workerDir !== '.') throw new PlatformError('Builder deployment requires repository-root application sources')
	if (app.configPath && app.configPath !== 'fabrika.config.ts' && app.configPath !== './fabrika.config.ts') {
		throw new PlatformError('Approved application config path does not match')
	}
	if (await git(root, ['status', '--porcelain=v1', '--untracked-files=all'], signal)) {
		throw new PlatformError('Commit all tracked and untracked source changes before deploying')
	}
	for (const name of ['fabrika.config.ts', 'zerops.yaml']) {
		noSymlinks(join(root, name))
		if (!lstatSync(join(root, name)).isFile()) throw new PlatformError('Application config and descriptor must be regular files')
		const entry = await git(root, ['ls-files', '--stage', '--', name], signal)
		if (!/^100(?:644|755) [0-9a-f]{40,64} 0\t/.test(entry)) {
			throw new PlatformError('Application config and descriptor must be tracked nonsymlink files')
		}
	}
	const sha = await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)
	if (!/^[0-9a-f]{40}$/.test(sha)) throw new PlatformError('Repository must have a full SHA-1 HEAD commit')
	// Read the configured URL, not `remote get-url`, which expands local transport rewrites.
	const remote = await git(root, ['config', '--get', 'remote.origin.url'], signal)
	if (repositoryIdentity(remote) !== repositoryIdentity(app.repoUrl)) {
		throw new PlatformError('Repository origin does not match the approved application')
	}
	const branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal)
	const refs = await git(root, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], signal)
	if (refs !== `${sha}\trefs/heads/${branch}`) throw new PlatformError('Push the current branch HEAD before deploying')
	return sha
}

export function compilerEnvironment(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const result: Record<string, string> = { NODE_ENV: 'production' }
	for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ']) {
		const value = source[key]
		if (value !== undefined) result[key] = value
	}
	return result
}

export function gitEnvironment(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const result: Record<string, string> = {}
	for (
		const key of [
			'HOME',
			'USER',
			'LOGNAME',
			'PATH',
			'LANG',
			'LC_ALL',
			'TERM',
			'DISPLAY',
			'WAYLAND_DISPLAY',
			'XDG_CONFIG_HOME',
			'SSH_AUTH_SOCK',
			'SSH_AGENT_PID',
			'SSH_ASKPASS',
			'SSH_ASKPASS_REQUIRE',
			'GIT_ASKPASS',
			'GIT_SSH',
			'GIT_SSH_COMMAND',
			'GIT_SSH_VARIANT',
			'GIT_TERMINAL_PROMPT',
			'GIT_CONFIG_GLOBAL',
			'GIT_CONFIG_SYSTEM',
			'GIT_CONFIG_NOSYSTEM',
			'GIT_SSL_CAINFO',
			'GIT_SSL_CAPATH',
			'SSL_CERT_FILE',
			'SSL_CERT_DIR',
		]
	) {
		const value = source[key]
		if (value !== undefined) result[key] = value
	}
	return result
}

export async function compileProject(root: string, env: string, appId: string, tempParent: string, signal: AbortSignal): Promise<FabrikaManifest> {
	noSymlinks(tempParent)
	const directory = mkdtempSync(join(tempParent, 'compile-'))
	chmodSync(directory, 0o700)
	const output = join(directory, 'manifest.json')
	try {
		const child = Bun.spawn([process.execPath, '--no-env-file', fileURLToPath(new URL('./platform-compiler.ts', import.meta.url)), env, output], {
			cwd: root,
			env: compilerEnvironment(process.env),
			stdout: 'ignore',
			stderr: 'ignore',
			stdin: 'ignore',
			signal,
			timeout: 120_000,
		})
		if (await child.exited !== 0) throw new PlatformError('Application compilation failed')
		noSymlinks(output)
		const stat = lstatSync(output)
		if (!stat.isFile() || stat.size > 1024 * 1024) throw new PlatformError('Invalid compiler result')
		const parsed: unknown = JSON.parse(readFileSync(output, 'utf8'))
		const manifest = parseFabrikaManifest(parsed, { appId, env })
		await verifyZeropsArtifactSourceDescriptor(manifest.target.sourceDescriptor)
		if (manifest.target.sourceDescriptor.contents !== readFileSync(join(root, 'zerops.yaml'), 'utf8')) {
			throw new PlatformError('Compiled descriptor differs from the source')
		}
		return manifest
	} catch (error) {
		throw error instanceof PlatformError ? error : new PlatformError('Application compilation returned an invalid manifest')
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}
