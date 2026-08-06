// The console's authorization vocabulary, as the deploy will send it.
//
// Same shape as the proxy manifest template and for the same reason: the declaration lives in the
// PRIVATE `@fabrika/control` and this package is published, so the deploy reads a COPY. What makes the
// copy a fact rather than a hope is this test plus CI's `gen:check`.

import { controlSchema } from '@fabrika/control/schema'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { REPO_ROOT } from '../artifacts'
import { platformConsoleSchemaArtifact } from '../console-schema'
import { PLATFORM_CONSOLE_APP_SCHEMA } from '../generated/platform-console-schema'

describe('the committed console schema', () => {
	test('is what the declaration produces', () => {
		const artifact = platformConsoleSchemaArtifact()
		expect(readFileSync(resolve(REPO_ROOT, artifact.path), 'utf8')).toBe(artifact.content)
	})

	test('is `controlSchema`, vocabulary for vocabulary', () => {
		expect(PLATFORM_CONSOLE_APP_SCHEMA).toEqual(controlSchema)
	})

	test('carries the roles a first operator is granted through, so an empty reconcile cannot lock the console', () => {
		expect(Object.keys(PLATFORM_CONSOLE_APP_SCHEMA.roles)).toContain('admin')
		expect(PLATFORM_CONSOLE_APP_SCHEMA.actions.length).toBeGreaterThan(0)
	})
})
