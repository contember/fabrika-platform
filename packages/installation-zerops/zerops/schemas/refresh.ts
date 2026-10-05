#!/usr/bin/env bun
// Refetch the two PUBLISHED Zerops JSON schemas this directory vendors.
//
//   bun packages/installation-zerops/zerops/schemas/refresh.ts
//
// They are vendored rather than fetched by the tests on purpose: a validation suite that needs the
// network is a suite that goes red when Zerops has a bad afternoon, and one that silently validates
// against a MOVED contract is worse than one that fails. Committing the documents makes a contract
// change show up as a reviewable diff.
//
// After refreshing, also regenerate the TypeScript view of the import schema:
//   bun packages/provider-zerops/scripts/generate-zerops-types.ts
// and re-run `bun run --filter @fabrika/installation-zerops gen` — the generated import documents are derived from
// those types, so a contract change should move both or neither.

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SCHEMA_SOURCES } from './check'

const main = async (): Promise<void> => {
	for (const [file, url] of Object.entries(SCHEMA_SOURCES)) {
		const response = await fetch(url)
		if (!response.ok) {
			throw new Error(`${url} → HTTP ${response.status}`)
		}
		// Round-trip through JSON.parse so a truncated or HTML response fails here rather than in a test.
		const document: unknown = await response.json()
		const path = resolve(import.meta.dir, file)
		writeFileSync(path, `${JSON.stringify(document, null, '\t')}\n`)
		console.info(`wrote ${path}`)
	}
}

await main()
