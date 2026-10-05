import { prepareZeropsDescriptor, verifyZeropsArtifactSourceDescriptor } from '@fabrika/provider-zerops'
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
	LOCAL_SOURCE_APPLICATION_ARCHIVE_FILE,
	LOCAL_SOURCE_MANIFEST_FILE,
	LOCAL_SOURCE_MAX_COMPRESSED_BYTES,
	LOCAL_SOURCE_MAX_EXPANDED_BYTES,
	LOCAL_SOURCE_MAX_MANIFEST_BYTES,
	LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE,
	type LocalSourceManifest,
	localSourceManifestSchema,
} from '../local-source-contract'
import { fixtureInputs, generateFixture, sha256 } from './generate'

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
	for (const kind of ['platform', 'application'] satisfies ('platform' | 'application')[]) {
		const fixture = manifest[kind]
		await verifyZeropsArtifactSourceDescriptor({ path: 'zerops.yaml', contents: fixture.descriptorContents, sha256: fixture.descriptorSha256 })
		prepareZeropsDescriptor(fixture.descriptorContents, kind === 'platform' ? 'proxy' : 'notesapi')
		const file = kind === 'platform' ? LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE : LOCAL_SOURCE_APPLICATION_ARCHIVE_FILE
		const archive = await readBoundedFile(join(directory, file), LOCAL_SOURCE_MAX_COMPRESSED_BYTES)
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
		const platform = await generateFixture(join(staging, 'platform'), 'platform')
		const application = await generateFixture(join(staging, 'application'), 'application')
		const manifest = localSourceManifestSchema.parse({ version: 1, platform: platform.fixture, application: application.fixture })
		if (JSON.stringify(manifest) !== JSON.stringify(await pinnedManifest())) {
			throw new Error('local source fixture inputs differ from the pinned identity')
		}
		await writeFile(join(staging, LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE), platform.archive)
		await writeFile(join(staging, LOCAL_SOURCE_APPLICATION_ARCHIVE_FILE), application.archive)
		await writeFile(join(staging, LOCAL_SOURCE_MANIFEST_FILE), `${JSON.stringify(manifest, null, '\t')}\n`)
		await loadLocalSourceFixtures(staging)
		await rename(join(staging, LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE), join(directory, LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE))
		await rename(join(staging, LOCAL_SOURCE_APPLICATION_ARCHIVE_FILE), join(directory, LOCAL_SOURCE_APPLICATION_ARCHIVE_FILE))
		await rename(join(staging, LOCAL_SOURCE_MANIFEST_FILE), join(directory, LOCAL_SOURCE_MANIFEST_FILE))
		return manifest
	} finally {
		await rm(staging, { recursive: true, force: true })
	}
}
