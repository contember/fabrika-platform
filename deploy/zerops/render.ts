#!/usr/bin/env bun
// Write (or check) every generated Zerops artifact.
//
//   bun run --filter @fabrika/deploy gen          # write
//   bun run --filter @fabrika/deploy gen:check    # exit 1 if anything on disk differs
//
// `gen:check` is redundant with the drift test in `__tests__/artifacts.test.ts` and exists anyway: it is
// the form a CI step or a pre-commit hook wants, and it needs no test runner.
//
// Every document is validated against Zerops' published JSON schema before it is written. A generator
// that can emit an invalid document is a generator whose output has to be checked by hand.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { type Artifact, generatedArtifacts, REPO_ROOT } from './artifacts'
import { assertArtifactMatchesSchema } from './validate'

const check = process.argv.includes('--check')

const read = (path: string): string | null => {
	try {
		return readFileSync(path, 'utf8')
	} catch {
		return null
	}
}

const write = (artifact: Artifact): void => {
	const path = resolve(REPO_ROOT, artifact.path)
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, artifact.content)
	console.info(`wrote ${artifact.path}`)
}

const artifacts = generatedArtifacts()
const stale: string[] = []
for (const artifact of artifacts) {
	assertArtifactMatchesSchema(artifact)
	if (!check) {
		write(artifact)
		continue
	}
	if (read(resolve(REPO_ROOT, artifact.path)) !== artifact.content) {
		stale.push(artifact.path)
	}
}

if (check) {
	if (stale.length > 0) {
		console.error(`stale generated artifacts (run \`bun run --filter @fabrika/deploy gen\`):\n  ${stale.join('\n  ')}`)
		process.exit(1)
	}
	console.info(`${artifacts.length} generated artifact(s) are up to date`)
}
