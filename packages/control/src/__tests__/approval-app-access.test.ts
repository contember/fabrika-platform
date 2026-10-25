// Application-wide data in the conservative access diff (ADR-0050 §3): an endpoint whose requirement becomes the app
// form widens, a new app endpoint says its grant is global, and a new application table names its reason and actions.

import { readContractSource } from '@fabrika/check/contract'
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { AccessSnapshot } from '../approval/snapshot'
import { classifyAccess } from './helpers/access'

const ROOT = join(import.meta.dir, '..', '..', '..', 'app', 'src', '__tests__', 'app-wide-fixture')
const ENDPOINTS = 'src/admin/endpoints.ts'
const TABLES = 'src/db/tables.ts'
const REACH = "actions: { read: 'candidates.read', appRead: ['candidates.export'], appCount: ['candidates.count'] }"
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
			effect: 'widens',
			line: 'New endpoint `api.admin.add` (POST /api/admin.add) for human callers with `positions.manage` (app-wide: a global grant)',
		})
		expect(changes).toContainEqual({
			effect: 'widens',
			line:
				'New application table `positions` (the open positions an administrator edits), read with `positions.read`, inserted with `positions.manage`, updated with `positions.manage`, removed with `positions.manage`',
		})
		expect(changes).toContainEqual({
			effect: 'widens',
			line: 'New application table `exports` (the log of every export across all candidates), read with `audit.read`, inserted with `candidates.export`',
		})
		expect(changes).toContainEqual({
			effect: 'widens',
			line:
				'New table policy `candidates` read with `candidates.read`, read app-wide with `candidates.export`, counted app-wide with `candidates.count`',
		})
	})

	test("an action the candidates' appRead or appCount gains widens; one it loses narrows", () => {
		const files = fixture()
		const narrower = new Map(files)
		const tables = files.get(TABLES) ?? ''
		expect(tables).toContain(REACH)
		narrower.set(TABLES, tables.replace(REACH, "actions: { read: 'candidates.read' }"))
		const gained = classifyAccess(snapshot(narrower), snapshot(files))
		expect(gained.outcome).toBe('widening')
		expect(gained.changes).toEqual([
			{ effect: 'widens', line: 'Table `candidates` is read app-wide with `candidates.export`' },
			{ effect: 'widens', line: 'Table `candidates` is counted app-wide with `candidates.count`' },
		])
		const lost = classifyAccess(snapshot(files), snapshot(narrower))
		expect(lost.outcome).toBe('no-widening')
		expect(lost.changes).toEqual([
			{ effect: 'narrows', line: 'Table `candidates` is no longer read app-wide with `candidates.export`' },
			{ effect: 'narrows', line: 'Table `candidates` is no longer counted app-wide with `candidates.count`' },
		])
	})

	test('a read action a table gains in its list widens and one it loses narrows; a single action replaced reads as before', () => {
		const files = fixture()
		const tables = files.get(TABLES) ?? ''
		const single = new Map(files)
		single.set(TABLES, tables.replace(REACH, "actions: { read: 'candidates.read' }"))
		const listed = new Map(files)
		listed.set(TABLES, tables.replace(REACH, "actions: { read: ['candidates.read', 'audit.read'] }"))
		const replaced = new Map(files)
		replaced.set(TABLES, tables.replace(REACH, "actions: { read: 'audit.read' }"))
		const gained = classifyAccess(snapshot(single), snapshot(listed))
		expect(gained.outcome).toBe('widening')
		expect(gained.changes).toEqual([{ effect: 'widens', line: 'Table `candidates` is read with `audit.read`' }])
		const lost = classifyAccess(snapshot(listed), snapshot(single))
		expect(lost.changes).toEqual([{ effect: 'narrows', line: 'Table `candidates` is no longer read with `audit.read`' }])
		expect(classifyAccess(snapshot(single), snapshot(replaced)).changes).toEqual([
			{ effect: 'widens', line: 'Table `candidates` read action changes from `"candidates.read"` to `"audit.read"`' },
		])
		expect(classifyAccess(snapshot(null), snapshot(listed)).changes).toContainEqual({
			effect: 'widens',
			line: 'New table policy `candidates` read with `audit.read` or `candidates.read`',
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
				effect: 'widens',
				line:
					'Endpoint `api.admin.add` requirement changes from `{"access":{"dimension":"candidate","form":"over"},"action":"positions.manage","kind":"action"}` to `{"access":{"form":"app"},"action":"positions.manage","kind":"action"}`',
			},
		])
		expect(classifyAccess(snapshot(files), snapshot(over)).outcome).toBe('widening')
	})
})
