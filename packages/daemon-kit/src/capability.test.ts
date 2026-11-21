import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createCapability, matchesCapability, readCapabilityFile, writeCapabilityFile } from './capability'

const scratch: string[] = []

function scratchDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'daemon-kit-capability-'))
	scratch.push(dir)
	return dir
}

afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('a capability is 32 random bytes, base64url', () => {
	const first = createCapability()
	expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
	expect(createCapability()).not.toBe(first)
})

test('the file is written 0600 in a 0700 directory and read back trimmed', () => {
	const directory = join(scratchDir(), 'daemon')
	mkdirSync(directory, { mode: 0o755 })
	const path = join(directory, 'token')
	writeFileSync(path, 'previous', { mode: 0o644 })
	writeCapabilityFile(path, 'capability')
	expect(statSync(directory).mode & 0o777).toBe(0o700)
	expect(statSync(path).mode & 0o777).toBe(0o600)
	expect(readCapabilityFile(path)).toBe('capability')
})

test('a missing or empty file reads as no capability', () => {
	const directory = scratchDir()
	expect(readCapabilityFile(join(directory, 'absent'))).toBeUndefined()
	writeFileSync(join(directory, 'empty'), '\n')
	expect(readCapabilityFile(join(directory, 'empty'))).toBeUndefined()
})

test('a directory that cannot be made private refuses the write', () => {
	if (process.getuid?.() === 0) return
	const parent = scratchDir()
	chmodSync(parent, 0o500)
	try {
		expect(() => writeCapabilityFile(join(parent, 'daemon', 'token'), 'capability')).toThrow()
	} finally {
		chmodSync(parent, 0o700)
	}
})

test('only the exact capability matches', () => {
	const capability = createCapability()
	expect(matchesCapability(capability, capability)).toBe(true)
	expect(matchesCapability(null, capability)).toBe(false)
	expect(matchesCapability(undefined, capability)).toBe(false)
	expect(matchesCapability('', capability)).toBe(false)
	expect(matchesCapability(`${capability}x`, capability)).toBe(false)
	expect(matchesCapability(`${capability.slice(0, -1)}x`, capability)).toBe(false)
})
