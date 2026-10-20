// `bun run fixtures:release <tag>`: records the Notes example as a released tag holds it, for ADR-0062's compatibility
// suite (`local:compat`). The files are the tag's `examples/zerops-app`, except its `bun.lock`: the example's own is the
// standalone mirror's, which its job regenerates, so the recorded one is what a `bun install` of the tag's pins writes
// from npm today. The record is committed, because a CI checkout holds no tags. A new record moves the pin
// (`bun run fixtures:pin`).

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ReleaseFixtureRecord, releaseFixtureRecordPath, releaseFixtureRecordSchema } from './generate'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const EXAMPLE = 'examples/zerops-app'

async function run(command: string[], cwd: string): Promise<void> {
	const child = Bun.spawn(command, { cwd, stdout: 'ignore', stderr: 'pipe', stdin: 'ignore' })
	const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()])
	if (code !== 0) throw new Error(`${command.join(' ')} failed:\n${errors}`)
}

async function regularFiles(root: string, directory: string = root): Promise<string[]> {
	const files: string[] = []
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name)
		if (entry.isDirectory()) files.push(...await regularFiles(root, path))
		else if (entry.isFile()) files.push(relative(root, path))
		else throw new Error(`${relative(root, path)} of the tag is not a regular file`)
	}
	return files
}

async function recordRelease(tag: string): Promise<ReleaseFixtureRecord> {
	// Outside the repository, so the install cannot take the workspace for its own.
	const staging = await mkdtemp(join(tmpdir(), 'fabrika-release-'))
	try {
		const archive = join(staging, 'example.tar')
		await run(['git', 'archive', '--format=tar', `--output=${archive}`, tag, EXAMPLE], REPO_ROOT)
		const root = join(staging, 'source')
		await mkdir(root)
		await run(['tar', '-xf', archive, '-C', root, '--strip-components=2'], staging)
		await rm(join(root, 'bun.lock'), { force: true })
		await run(['bun', 'install', '--lockfile-only', '--ignore-scripts'], root)
		const files: Record<string, string> = {}
		for (const path of (await regularFiles(root)).sort()) files[path] = await readFile(join(root, path), 'utf8')
		return releaseFixtureRecordSchema.parse({ version: 1, tag, files })
	} finally {
		await rm(staging, { recursive: true, force: true })
	}
}

const tag = Bun.argv[2] ?? ''
if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
	console.error('usage: bun run fixtures:release v<major>.<minor>.<patch>')
	process.exit(1)
}
const record = await recordRelease(tag)
await writeFile(releaseFixtureRecordPath(tag), `${JSON.stringify(record, null, '\t')}\n`)
console.info(`recorded ${EXAMPLE} at ${tag}: ${Object.keys(record.files).length} files`)
