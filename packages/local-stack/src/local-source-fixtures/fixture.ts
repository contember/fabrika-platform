import { prepareZeropsDescriptor, verifyZeropsArtifactSourceDescriptor } from '@fabrika/provider-zerops'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
	LOCAL_SOURCE_AGENT_CHANGE_DIRECTORY,
	LOCAL_SOURCE_ARCHIVE_FILES,
	LOCAL_SOURCE_FIXTURE_KINDS,
	LOCAL_SOURCE_MANIFEST_FILE,
	LOCAL_SOURCE_MAX_COMPRESSED_BYTES,
	LOCAL_SOURCE_MAX_EXPANDED_BYTES,
	LOCAL_SOURCE_MAX_MANIFEST_BYTES,
	type LocalSourceFixture,
	type LocalSourceManifest,
	localSourceManifestSchema,
} from '../local-source-contract'
import { fixtureInputs, generateFixtures, sha256 } from './generate'

async function readBoundedFile(path: string, limit: number): Promise<Buffer> {
	const stat = await lstat(path)
	if (!stat.isFile() || stat.size > limit) throw new Error('invalid local source fixture file or byte budget')
	const bytes = await readFile(path)
	if (bytes.byteLength > limit) throw new Error('local source fixture byte budget exceeded')
	return bytes
}

async function pinnedManifest(): Promise<LocalSourceManifest> {
	return localSourceManifestSchema.parse(
		JSON.parse((await readBoundedFile(join(fixtureInputs, 'manifest.json'), LOCAL_SOURCE_MAX_MANIFEST_BYTES)).toString()),
	)
}

export async function loadLocalSourceFixtures(directory: string): Promise<LocalSourceManifest> {
	const manifest = localSourceManifestSchema.parse(
		JSON.parse((await readBoundedFile(join(directory, LOCAL_SOURCE_MANIFEST_FILE), LOCAL_SOURCE_MAX_MANIFEST_BYTES)).toString()),
	)
	// A self-consistent replacement must not silently move a persisted namespace pin.
	if (JSON.stringify(manifest) !== JSON.stringify(await pinnedManifest())) {
		throw new Error('local source fixture identity mismatch; explicit reset required')
	}
	for (const kind of LOCAL_SOURCE_FIXTURE_KINDS) {
		const fixture = manifest[kind]
		await verifyZeropsArtifactSourceDescriptor({ path: 'zerops.yaml', contents: fixture.descriptorContents, sha256: fixture.descriptorSha256 })
		prepareZeropsDescriptor(fixture.descriptorContents, kind === 'platform' ? 'proxy' : 'notesapi')
		const archive = await readBoundedFile(join(directory, LOCAL_SOURCE_ARCHIVE_FILES[kind]), LOCAL_SOURCE_MAX_COMPRESSED_BYTES)
		if (archive.byteLength !== fixture.archiveBytes || sha256(archive) !== fixture.archiveSha256) {
			throw new Error('local source fixture archive mismatch')
		}
		gunzipSync(archive, { maxOutputLength: LOCAL_SOURCE_MAX_EXPANDED_BYTES })
	}
	return manifest
}

export async function prepareLocalSourceFixtures(directory: string): Promise<LocalSourceManifest> {
	await mkdir(directory, { recursive: true })
	if ((await readdir(directory)).length !== 0) return loadLocalSourceFixtures(directory)
	const staging = await mkdtemp(join(directory, '.prepare-'))
	try {
		const { manifest, generated } = await generateFixtures(staging)
		if (JSON.stringify(manifest) !== JSON.stringify(await pinnedManifest())) {
			throw new Error('local source fixture inputs differ from the pinned identity')
		}
		for (const kind of LOCAL_SOURCE_FIXTURE_KINDS) await writeFile(join(staging, LOCAL_SOURCE_ARCHIVE_FILES[kind]), generated[kind].archive)
		await writeFiles(join(staging, LOCAL_SOURCE_AGENT_CHANGE_DIRECTORY), generated.agentChange.files)
		await writeFile(join(staging, LOCAL_SOURCE_MANIFEST_FILE), `${JSON.stringify(manifest, null, '\t')}\n`)
		await loadLocalSourceFixtures(staging)
		for (const kind of LOCAL_SOURCE_FIXTURE_KINDS) {
			await rename(join(staging, LOCAL_SOURCE_ARCHIVE_FILES[kind]), join(directory, LOCAL_SOURCE_ARCHIVE_FILES[kind]))
		}
		await rename(join(staging, LOCAL_SOURCE_AGENT_CHANGE_DIRECTORY), join(directory, LOCAL_SOURCE_AGENT_CHANGE_DIRECTORY))
		await rename(join(staging, LOCAL_SOURCE_MANIFEST_FILE), join(directory, LOCAL_SOURCE_MANIFEST_FILE))
		return manifest
	} finally {
		await rm(staging, { recursive: true, force: true })
	}
}

async function writeFiles(root: string, files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>): Promise<void> {
	for (const [path, bytes] of files) {
		await mkdir(dirname(join(root, path)), { recursive: true })
		await writeFile(join(root, path), bytes, { mode: 0o644 })
	}
}

const gitBlobSha = (bytes: Uint8Array): string => createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')

/**
 * Every blob of a fixture's pinned tree, from `source` (`applicationFixtureSource`) and checked against its Git blob
 * id, so the GitHub double serves exactly the committed bytes. A file edited since the fixture was generated needs a
 * reset.
 */
export function readFixtureFiles(
	fixture: LocalSourceFixture,
	source: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
): ReadonlyMap<string, Uint8Array<ArrayBuffer>> {
	const files = new Map<string, Uint8Array<ArrayBuffer>>()
	for (const entry of fixture.tree) {
		if (entry.type !== 'blob' || entry.mode === '120000') continue
		const bytes = source.get(entry.path)
		if (bytes === undefined || gitBlobSha(bytes) !== entry.sha) {
			throw new Error(`local source fixture file ${entry.path} changed since its pin; explicitly reset the local stack`)
		}
		files.set(entry.path, bytes)
	}
	return files
}
