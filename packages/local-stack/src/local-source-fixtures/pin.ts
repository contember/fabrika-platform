// `bun run fixtures:pin`: regenerates the pinned identity of every source fixture after an intended change of their
// inputs, for example an edit of the Notes example or of the agent change patch. A persisted stack then needs `local:reset`.

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fixtureInputs, generateFixtures } from './generate'

const staging = await mkdtemp(join(import.meta.dir, '.pin-'))
try {
	const { manifest } = await generateFixtures(staging)
	await Bun.write(join(fixtureInputs, 'manifest.json'), `${JSON.stringify(manifest, null, '\t')}\n`)
	console.info(
		`pinned application commit ${manifest.application.commitSha}, agent change ${manifest.agentChange.commitSha}, releases ${manifest.release055.commitSha} and ${manifest.release048.commitSha} (platform ${manifest.platform.commitSha})`,
	)
} finally {
	await rm(staging, { recursive: true, force: true })
}
