import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { parsePlatformUpgradeArgs } from '../upgrade-options'

describe('fabrika platform upgrade --provider=zerops (arguments)', () => {
	test('names the sidecar after the installation, exactly as `init` does', () => {
		expect(parsePlatformUpgradeArgs(['--to=v0.1.0', 'test'])).toEqual({
			to: 'v0.1.0',
			sidecar: { kind: 'checkout', dir: resolve(process.cwd(), 'fabrika-zerops-test') },
			installation: 'test',
			dryRun: false,
		})
	})

	test('refuses a branch, a SHA and an empty ref before anything is contacted (ADR-0025)', () => {
		expect(() => parsePlatformUpgradeArgs(['--to=main', 'test'])).toThrow('is not a published tag')
		expect(() => parsePlatformUpgradeArgs(['--to=0123456789abcdef0123456789abcdef01234567', 'test'])).toThrow('never a branch')
		expect(() => parsePlatformUpgradeArgs(['--to=', 'test'])).toThrow('--to=<tag> is required')
		expect(parsePlatformUpgradeArgs(['--to= v1.2.3 ', 'test']).to).toBe('v1.2.3')
	})

	test('tells a repository from a path by SHAPE, so the answer never depends on what exists on disk', () => {
		expect(parsePlatformUpgradeArgs(['--to=v0.1.0', '--sidecar=contember/fabrika-zerops-test']).sidecar).toEqual({
			kind: 'repo',
			repo: 'contember/fabrika-zerops-test',
		})
		// A leading `./` is what makes a repository-shaped value a directory instead.
		expect(parsePlatformUpgradeArgs(['--to=v0.1.0', '--sidecar=./contember/fabrika-zerops-test']).sidecar).toEqual({
			kind: 'checkout',
			dir: './contember/fabrika-zerops-test',
		})
		expect(parsePlatformUpgradeArgs(['--to=v0.1.0', '--sidecar=/srv/sidecars/test']).sidecar).toEqual({
			kind: 'checkout',
			dir: '/srv/sidecars/test',
		})
	})

	test('an explicit sidecar wins over the installation name, which is then only the commit subject', () => {
		expect(parsePlatformUpgradeArgs(['--to=v0.1.0', 'test', '--sidecar=/srv/sidecars/test'])).toEqual({
			to: 'v0.1.0',
			sidecar: { kind: 'checkout', dir: '/srv/sidecars/test' },
			installation: 'test',
			dryRun: false,
		})
	})

	test('refuses an unknown flag, a second installation and a repeated value rather than ignoring any of them', () => {
		expect(() => parsePlatformUpgradeArgs(['--to=v0.1.0', '--token=nope', 'test'])).toThrow('unexpected argument `--token=nope`')
		expect(() => parsePlatformUpgradeArgs(['--to=v0.1.0', '--sidecar', 'test'])).toThrow('unexpected argument `--sidecar`')
		expect(() => parsePlatformUpgradeArgs(['--to=v0.1.0', 'one', 'two'])).toThrow('name ONE installation')
		expect(() => parsePlatformUpgradeArgs(['--to=v0.1.0', '--to=v0.2.0', 'test'])).toThrow('--to was given more than once')
	})

	test('names both ways of finding the sidecar when neither was given', () => {
		expect(() => parsePlatformUpgradeArgs(['--to=v0.1.0'])).toThrow('--sidecar=<path>|<owner>/<name>')
	})

	test('--dry-run is a flag and not a value', () => {
		expect(parsePlatformUpgradeArgs(['--to=v0.1.0', 'test', '--dry-run']).dryRun).toBe(true)
	})
})
