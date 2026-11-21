import { randomBytes, timingSafeEqual } from 'crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'

/**
 * A daemon's CLI capability: a fresh random secret its owner's CLI presents on the routes only the CLI calls. A loopback
 * port is reachable by every local process and OS user; the capability file is readable by the owner alone.
 */
export function createCapability(): string {
	return randomBytes(32).toString('base64url')
}

/**
 * Writes the capability for the owner's CLI into a new file: the directory `0700`, the file `0600`. Throws when either cannot be made so,
 * e.g. a directory another user created first.
 */
export function writeCapabilityFile(path: string, capability: string): void {
	const directory = dirname(path)
	mkdirSync(directory, { recursive: true, mode: 0o700 })
	chmodSync(directory, 0o700)
	// A new file, never one already there: a symlink or a file planted before the directory was private is not followed.
	rmSync(path, { force: true })
	writeFileSync(path, capability, { mode: 0o600, flag: 'wx' })
}

/** The capability a running daemon wrote, or undefined when there is none. Read per request: a restarted daemon writes a new one. */
export function readCapabilityFile(path: string): string | undefined {
	try {
		const capability = readFileSync(path, 'utf-8').trim()
		return capability === '' ? undefined : capability
	} catch {
		return undefined
	}
}

/** Whether `presented` is the capability, compared in constant time. */
export function matchesCapability(presented: string | null | undefined, capability: string): boolean {
	if (presented === null || presented === undefined) return false
	const expected = Buffer.from(capability)
	const actual = Buffer.from(presented)
	return actual.length === expected.length && timingSafeEqual(actual, expected)
}
