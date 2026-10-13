// Application-wide data in the conservative access diff (ADR-0050 §3): an endpoint whose requirement becomes the app
// form widens, a new app endpoint says its grant is global, and a new application table names its reason and actions.

import { readContractSource } from '@fabrika/check/contract'
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { classifyAccess } from '../approval/diff'
import type { AccessSnapshot } from '../approval/snapshot'

const ROOT = join(import.meta.dir, '..', '..', '..', 'app', 'src', '__tests__', 'app-wide-fixture')
const ENDPOINTS = 'src/admin/endpoints.ts'
const ADD = "access: { action: 'positions.manage', app: true } })\n\t\t.handle(async ({ input, ctx }) => ctx.db.app.positions.insert"

const fixture = (): Map<string, string> => {
	const files = new Map<string, string>()
	for (const entry of readdirSync(ROOT, { recursive: true, withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
			const path = join(entry.parentPath, entry.name)
			files.set(relative(ROOT, path), readFileSync(path, 'utf8'))
		}
	}
	return files
}

function snapshot(files: ReadonlyMap<string, string> | null): AccessSnapshot {
	return { version: 1, contract: files === null ? null : readContractSource(files), migrations: [], checker: '0.0.0' }
}

describe('application-wide data in the approval diff', () => {
	test('a new app endpoint says its grant is global; a new application table names its reason and every action', () => {
		const { changes } = classifyAccess(snapshot(null), snapshot(fixture()))
		expect(changes).toContainEqual({
			widens: true,
			line: 'New endpoint `api.admin.add` (POST /api/admin.add) for human callers with `positions.manage` (app-wide: a global grant)',
		})
		expect(changes).toContainEqual({
			widens: true,
			line:
				'New application table `positions` (the open positions an administrator edits), read with `positions.read`, inserted with `positions.manage`, updated with `positions.manage`, removed with `positions.manage`',
		})
		expect(changes).toContainEqual({
			widens: true,
			line: 'New application table `exports` (the log of every export across all candidates), read with `audit.read`, inserted with `candidates.read`',
		})
	})

	test('an endpoint whose requirement becomes the app form widens, and so does the way back', () => {
		const files = fixture()
		const over = new Map(files)
		const source = files.get(ENDPOINTS) ?? ''
		expect(source).toContain(ADD)
		over.set(ENDPOINTS, source.replace(ADD, ADD.replace('app: true', "over: 'candidate'")))
		const toApp = classifyAccess(snapshot(over), snapshot(files))
		expect(toApp.outcome).toBe('widening')
		expect(toApp.changes).toEqual([
			{
				widens: true,
				line:
					'Endpoint `api.admin.add` requirement changes from `{"access":{"dimension":"candidate","form":"over"},"action":"positions.manage","kind":"action"}` to `{"access":{"form":"app"},"action":"positions.manage","kind":"action"}`',
			},
		])
		expect(classifyAccess(snapshot(files), snapshot(over)).outcome).toBe('widening')
	})
})
