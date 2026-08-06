#!/usr/bin/env bun
// Write (or check) every generated Zerops artifact.
//
//   bun run --filter @fabrika/installation-zerops gen          # write
//   bun run --filter @fabrika/installation-zerops gen:check    # exit 1 if anything on disk differs
//
// `gen:check` is redundant with the drift test in `__tests__/artifacts.test.ts` and exists anyway: it is
// the form a CI step or a pre-commit hook wants, and it needs no test runner.
//
// Every Zerops document is validated against Zerops' published JSON schema before it is written. A
// generator that can emit an invalid document is a generator whose output has to be checked by hand.
// The proxy manifest template is not a Zerops document and is checked against the proxy's OWN parser
// instead, by the generator that builds it.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { type Artifact, generatedArtifacts, REPO_ROOT } from './artifacts'
import { platformConsoleSchemaArtifact } from './console-schema'
import { platformProxyManifestArtifact } from './proxy-manifest'
import { assertArtifactMatchesSchema } from './validate'

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

export const renderZeropsInstallation = (check: boolean): void => {
	const zeropsDocuments = generatedArtifacts()
	for (const document of zeropsDocuments) {
		assertArtifactMatchesSchema(document)
	}
	const artifacts = [...zeropsDocuments, platformProxyManifestArtifact(), platformConsoleSchemaArtifact()]
	const stale: string[] = []
	for (const artifact of artifacts) {
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
			throw new Error(
				`stale generated artifacts (run \`bun run --filter @fabrika/installation-zerops gen\`):\n  ${stale.join('\n  ')}`,
			)
		}
		console.info(`${artifacts.length} generated artifact(s) are up to date`)
	}
}

if (import.meta.main) {
	try {
		renderZeropsInstallation(process.argv.includes('--check'))
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error))
		process.exit(1)
	}
}
