import { expect, test } from 'bun:test'
import { existsSync } from 'fs'
import { join } from 'path'
import { DEFAULT_PROFILE, resolveCatalogRoot, resolveStackPointer, supportedProfiles } from '../src/catalog'

test('resolveCatalogRoot finds the fabrika source root with stacks/ + decisions/', () => {
	const root = resolveCatalogRoot()
	expect(root).not.toBeNull()
	expect(existsSync(join(root!, 'stacks'))).toBe(true)
	expect(existsSync(join(root!, 'decisions'))).toBe(true)
})

test('resolveStackPointer returns absolute paths for a known preset', () => {
	const p = resolveStackPointer('cf-lightweight')
	expect(p).not.toBeNull()
	expect(p!.profile).toBe('cf-lightweight')
	expect(p!.stackFileExists).toBe(true)
	expect(p!.stackFile.endsWith('/stacks/cf-lightweight.md')).toBe(true)
	expect(p!.decisionsDir.endsWith('/decisions')).toBe(true)
	expect(p!.stackFile.startsWith('/')).toBe(true)
	expect(existsSync(p!.stackFile)).toBe(true)
})

test('resolveStackPointer flags an unknown preset but still hands back the decisions dir', () => {
	const p = resolveStackPointer('does-not-exist')
	expect(p).not.toBeNull()
	expect(p!.stackFileExists).toBe(false)
	expect(existsSync(p!.decisionsDir)).toBe(true)
})

test('the default preset and cf-app are the supported ones; the others are marked unsupported', () => {
	expect(DEFAULT_PROFILE).toBe('zerops-app')
	expect(supportedProfiles()).toEqual(['cf-app', 'zerops-app'])
	expect(resolveStackPointer('zerops-app')!.support).toBe('supported')
	for (const profile of ['cf-lightweight', 'cf-fat', 'cf-internal-app', 'contember-app', 'content-site']) {
		expect(resolveStackPointer(profile)!.support, profile).toBe('unsupported')
	}
	expect(resolveStackPointer('does-not-exist')!.support).toBeNull()
})
