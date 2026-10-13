import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sidecarCheckoutDir } from '../checkout'

test('a sidecar checkout lands in the working directory, or where --checkout says, outside any repository', () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'sidecar-checkout-')))
	try {
		expect(sidecarCheckoutDir(undefined, 'fabrika-zerops-test', root)).toBe(join(root, 'fabrika-zerops-test'))
		expect(sidecarCheckoutDir('elsewhere/sidecar', 'fabrika-zerops-test', root)).toBe(join(root, 'elsewhere', 'sidecar'))
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('a sidecar checkout inside another repository is refused, naming the repository and the flag', () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'sidecar-checkout-')))
	try {
		const repository = join(root, 'project')
		mkdirSync(join(repository, '.git'), { recursive: true })
		expect(() => sidecarCheckoutDir(undefined, 'fabrika-zerops-test', repository)).toThrow(`inside the git repository at ${repository}`)
		expect(() => sidecarCheckoutDir(undefined, 'fabrika-zerops-test', join(repository, 'nested'))).toThrow('--checkout=<dir>')
		expect(sidecarCheckoutDir(join(root, 'outside'), 'fabrika-zerops-test', repository)).toBe(join(root, 'outside'))
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('an existing sidecar checkout is not its own enclosing repository', () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'sidecar-checkout-')))
	try {
		mkdirSync(join(root, 'fabrika-zerops-test', '.git'), { recursive: true })
		expect(sidecarCheckoutDir(undefined, 'fabrika-zerops-test', root)).toBe(join(root, 'fabrika-zerops-test'))
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('a checkout reached through a symlink into a repository is still inside it', () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'sidecar-checkout-')))
	try {
		const repository = join(root, 'project')
		mkdirSync(join(repository, '.git'), { recursive: true })
		mkdirSync(join(repository, 'sub'))
		symlinkSync(join(repository, 'sub'), join(root, 'link'))
		expect(() => sidecarCheckoutDir(join(root, 'link', 'sidecar'), 'unused', root)).toThrow('inside the git repository')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
