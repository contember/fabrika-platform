import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ensureRuntimeDir, userRuntimeDir } from './runtime-dir'

let root: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'daemon-kit-runtime-dir-'))
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

test('the runtime directory is the app under XDG_RUNTIME_DIR, else a temp directory named after the user', () => {
	expect(userRuntimeDir('agent-canvas', { XDG_RUNTIME_DIR: '/run/user/1000' })).toBe('/run/user/1000/agent-canvas')
	const perUser = join(tmpdir(), `agent-canvas-${process.getuid?.()}`)
	expect(userRuntimeDir('agent-canvas', {})).toBe(perUser)
	// A relative value is not a runtime directory (XDG Base Directory: such a value is ignored).
	expect(userRuntimeDir('agent-canvas', { XDG_RUNTIME_DIR: 'run' })).toBe(perUser)
})

test('a new runtime directory is created 0700, and an existing one of the user is closed to 0700', () => {
	const fresh = join(root, 'fresh')
	expect(ensureRuntimeDir(fresh)).toBe(fresh)
	expect(statSync(fresh).mode & 0o777).toBe(0o700)

	const open = join(root, 'open')
	mkdirSync(open, { mode: 0o755 })
	chmodSync(open, 0o777)
	ensureRuntimeDir(open)
	expect(statSync(open).mode & 0o777).toBe(0o700)
})

test('a symlink in its place is refused and not followed, so its target stays as it was', () => {
	const target = join(root, 'elsewhere')
	mkdirSync(target, { mode: 0o755 })
	chmodSync(target, 0o755)
	const link = join(root, 'agent-canvas')
	symlinkSync(target, link)
	expect(() => ensureRuntimeDir(link)).toThrow('is not a private directory of this user')
	expect(lstatSync(link).isSymbolicLink()).toBe(true)
	expect(statSync(target).mode & 0o777).toBe(0o755)
	expect(readdirSync(target)).toEqual([])
})

test('a file in its place is refused', () => {
	const file = join(root, 'agent-canvas')
	writeFileSync(file, '')
	expect(() => ensureRuntimeDir(file)).toThrow()
})
