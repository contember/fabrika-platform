import { APP_AGENT_SKILL_NAME, readAppAgentSkill } from '@fabrika/app/agent-skill'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'
import { z } from 'zod'

const HERE = dirname(fileURLToPath(import.meta.url))
const MANIFEST_VERSION = 1
const MANIFEST_RELATIVE_PATH = join('.fabrika', 'agent-support.json')

export type AgentHost = 'claude' | 'codex'

export interface InjectOptions {
	hosts?: AgentHost[]
}

const managedFileSchema = z.object({ installedHash: z.string(), host: z.enum(['claude', 'codex']) })
const managedManifestSchema = z.object({ files: z.record(managedFileSchema.nullable().catch(null)) })

function isAgentHost(value: string): value is AgentHost {
	return value === 'claude' || value === 'codex'
}

export interface InjectResult {
	sourceDir: string | null
	hosts: AgentHost[]
	written: string[]
	updated: string[]
	skipped: string[]
	preserved: string[]
}

interface ManagedManifest {
	version: number
	files: Record<string, { installedHash: string; host: AgentHost }>
}

interface DesiredFile {
	relativePath: string
	content: string
	host: AgentHost
}

interface AgentSource {
	filename: string
	name: string
	description: string
	body: string
	raw: string
}

export function resolveSkillSource(): string | null {
	const candidates = [resolve(HERE, '../../skill')]
	for (const candidate of candidates) {
		if (existsSync(join(candidate, 'SKILL.md'))) return candidate
	}
	return null
}

export function parseAgentHosts(value?: string): AgentHost[] {
	if (!value || value === 'all') return ['claude', 'codex']
	const requested = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]
	if (!requested.every(isAgentHost) || requested.length === 0) {
		throw new Error(`Invalid --agent value: ${value}. Use claude, codex, or all.`)
	}
	return requested
}

export function injectAgentSupport(repoRoot: string, opts: InjectOptions = {}): InjectResult {
	const sourceDir = resolveSkillSource()
	const hosts = normalizeHosts(opts.hosts)
	const result: InjectResult = {
		sourceDir,
		hosts,
		written: [],
		updated: [],
		skipped: [],
		preserved: [],
	}
	if (!sourceDir) return result

	const root = resolve(repoRoot)
	const desired = renderDesiredFiles(sourceDir, hosts)
	const manifestPath = join(root, MANIFEST_RELATIVE_PATH)
	const manifest = readManifest(manifestPath)

	for (const file of desired) {
		installManagedFile(root, file, manifest, result)
	}
	writeManifest(manifestPath, manifest)
	return result
}

export function injectSkills(repoRoot: string): InjectResult {
	return injectAgentSupport(repoRoot, { hosts: ['claude'] })
}

function normalizeHosts(hosts?: AgentHost[]): AgentHost[] {
	const selected: AgentHost[] = hosts?.length ? hosts : ['claude', 'codex']
	return [...new Set(selected)].sort()
}

function renderDesiredFiles(sourceDir: string, hosts: AgentHost[]): DesiredFile[] {
	const skill = readFileSync(join(sourceDir, 'SKILL.md'), 'utf-8')
	const agents = readAgentSources(join(sourceDir, 'agents'))
	const resources = readSkillResources(sourceDir)
	const appSkill = readAppAgentSkill()
	const files: DesiredFile[] = []

	for (const host of hosts) {
		const skillsDir = host === 'claude' ? join('.claude', 'skills') : join('.agents', 'skills')
		const skillRoot = join(skillsDir, 'fabrika')
		files.push({
			relativePath: join(skillRoot, 'SKILL.md'),
			content: host === 'claude' ? renderClaudeSkill(skill) : skill,
			host,
		})
		files.push({ relativePath: join(skillsDir, APP_AGENT_SKILL_NAME, 'SKILL.md'), content: appSkill.text, host })
		for (const resource of resources) {
			if (host === 'claude' && resource.relativePath === join('agents', 'openai.yaml')) continue
			files.push({
				relativePath: join(skillRoot, resource.relativePath),
				content: resource.content,
				host,
			})
		}
	}

	if (hosts.includes('claude')) {
		for (const agent of agents) {
			files.push({
				relativePath: join('.claude', 'agents', agent.filename),
				content: agent.raw,
				host: 'claude',
			})
		}
	}
	if (hosts.includes('codex')) {
		for (const agent of agents) {
			files.push({
				relativePath: join('.codex', 'agents', agent.filename.replace(/\.md$/, '.toml')),
				content: renderCodexAgent(agent),
				host: 'codex',
			})
		}
	}

	return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

function readSkillResources(sourceDir: string): Array<{ relativePath: string; content: string }> {
	const resources: Array<{ relativePath: string; content: string }> = []
	for (const directory of ['agents', 'gates']) {
		const absoluteDir = join(sourceDir, directory)
		if (!existsSync(absoluteDir)) continue
		for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
			if (!entry.isFile()) continue
			if (directory === 'gates' && !entry.name.endsWith('.jsx')) continue
			if (directory === 'agents' && !entry.name.endsWith('.md') && entry.name !== 'openai.yaml') continue
			resources.push({
				relativePath: join(directory, entry.name),
				content: readFileSync(join(absoluteDir, entry.name), 'utf-8'),
			})
		}
	}
	return resources
}

function readAgentSources(agentsDir: string): AgentSource[] {
	if (!existsSync(agentsDir)) return []
	return readdirSync(agentsDir)
		.filter((entry) => entry.endsWith('.md'))
		.sort()
		.map((filename) => parseAgentSource(filename, readFileSync(join(agentsDir, filename), 'utf-8')))
}

function parseAgentSource(filename: string, raw: string): AgentSource {
	const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
	if (!match) throw new Error(`Agent source ${filename} has no valid frontmatter.`)
	const metadata = match[1]!
	const name = metadata.match(/^name:\s*(.+)$/m)?.[1]?.trim()
	const metadataLines = metadata.split('\n')
	const descriptionIndex = metadataLines.findIndex((line) => line.startsWith('description:'))
	let description: string | undefined
	if (descriptionIndex >= 0) {
		const inline = metadataLines[descriptionIndex]!.slice('description:'.length).trim()
		if (inline === '>' || inline === '|') {
			const descriptionLines: string[] = []
			for (let index = descriptionIndex + 1; index < metadataLines.length; index++) {
				const line = metadataLines[index]!
				if (line.length > 0 && !/^\s/.test(line)) break
				descriptionLines.push(line.trim())
			}
			description = descriptionLines.filter(Boolean).join(' ')
		} else {
			description = inline
		}
	}
	if (!name || !description) throw new Error(`Agent source ${filename} is missing name or description.`)
	return { filename, name, description, body: match[2]!.trim() + '\n', raw }
}

function renderClaudeSkill(canonical: string): string {
	return canonical.replace(
		/\n---\n/,
		'\nallowed-tools: Bash(bunx fabrika:*), Bash(bun:*), Read, Write, Edit, Glob, Grep, Skill, Agent\n---\n',
	)
}

function renderCodexAgent(agent: AgentSource): string {
	return [
		`name = ${tomlString(agent.name)}`,
		`description = ${tomlString(agent.description)}`,
		`developer_instructions = ${tomlMultiline(agent.body)}`,
		'',
	].join('\n')
}

function tomlString(value: string): string {
	return JSON.stringify(value)
}

function tomlMultiline(value: string): string {
	const escaped = value.replace(/\\/g, '\\\\').replace(/\"\"\"/g, '\\"\\"\\"')
	return `\"\"\"\n${escaped}\"\"\"`
}

function installManagedFile(
	root: string,
	desired: DesiredFile,
	manifest: ManagedManifest,
	result: InjectResult,
): void {
	const destination = join(root, desired.relativePath)
	const desiredHash = hash(desired.content)
	const existing = existsSync(destination) ? readFileSync(destination, 'utf-8') : null
	const existingHash = existing === null ? null : hash(existing)
	const recorded = manifest.files[desired.relativePath]

	if (existing === null) {
		writeAtomic(destination, desired.content)
		result.written.push(destination)
	} else if (existingHash === desiredHash) {
		result.skipped.push(destination)
	} else if (existingHash === recorded?.installedHash) {
		writeAtomic(destination, desired.content)
		result.updated.push(destination)
	} else {
		result.preserved.push(destination)
		return
	}

	manifest.files[desired.relativePath] = { installedHash: desiredHash, host: desired.host }
}

function readManifest(path: string): ManagedManifest {
	if (!existsSync(path)) return { version: MANIFEST_VERSION, files: {} }
	try {
		const parsed = managedManifestSchema.safeParse(JSON.parse(readFileSync(path, 'utf-8')))
		if (!parsed.success) return { version: MANIFEST_VERSION, files: {} }
		const files: ManagedManifest['files'] = {}
		for (const [relativePath, candidate] of Object.entries(parsed.data.files)) {
			if (candidate !== null) files[relativePath] = candidate
		}
		return {
			version: MANIFEST_VERSION,
			files,
		}
	} catch {
		return { version: MANIFEST_VERSION, files: {} }
	}
}

function writeManifest(path: string, manifest: ManagedManifest): void {
	writeAtomic(path, JSON.stringify(manifest, null, 2) + '\n')
}

function writeAtomic(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true })
	const temp = `${path}.${process.pid}.tmp`
	writeFileSync(temp, content)
	renameSync(temp, path)
}

function hash(content: string): string {
	return createHash('sha256').update(content).digest('hex')
}

export function manifestRelativePath(repoRoot: string): string {
	return relative(resolve(repoRoot), join(resolve(repoRoot), MANIFEST_RELATIVE_PATH))
}
