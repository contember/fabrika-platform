/**
 * The deployer reads a contract application's contract from the checkout's text with the static reader Control runs at
 * the commit (ADR-0048), until the run carries its approved snapshot.
 */

import { compileContract } from '@fabrika/app/contract'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contract } from '../../../app/src/__tests__/fixtures/scoped-notes/fabrika.contract'
import { tables } from '../../../app/src/__tests__/fixtures/scoped-notes/src/db/tables'
import { defaultCloudflareCollaborators } from '..'

const SCOPED_NOTES = join(import.meta.dir, '..', '..', '..', 'app', 'src', '__tests__', 'fixtures', 'scoped-notes')
const readContract = defaultCloudflareCollaborators.readContract

let root: string

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), 'fabrika-contract-reader-'))
})

afterAll(async () => {
	await rm(root, { recursive: true, force: true })
})

const checkout = async (name: string): Promise<string> => {
	const dir = join(root, name)
	await mkdir(dir)
	return dir
}

describe('the checkout contract reader', () => {
	test('reads the contract and its table policies from source, as compileContract would', async () => {
		const dir = await checkout('scoped-notes')
		await cp(SCOPED_NOTES, dir, { recursive: true })
		expect(await readContract(dir)).toEqual(compileContract(contract, tables))
	})

	test('an application root without fabrika.contract.ts has no contract', async () => {
		const dir = await checkout('plain')
		await writeFile(join(dir, 'fabrika.config.ts'), 'export default {}\n')
		expect(await readContract(dir)).toBeNull()
	})

	test('a contract it cannot read statically fails the deploy rather than dropping the lock-down', async () => {
		const dir = await checkout('computed')
		await writeFile(join(dir, 'fabrika.contract.ts'), 'export const contract = globalThis.makeContract()\n')
		await expect(readContract(dir)).rejects.toThrow('the contract cannot be read from source')
	})

	test('a linked fabrika.contract.ts is refused', async () => {
		const dir = await checkout('linked')
		await writeFile(join(dir, 'elsewhere.ts'), 'export const contract = 1\n')
		await symlink(join(dir, 'elsewhere.ts'), join(dir, 'fabrika.contract.ts'))
		await expect(readContract(dir)).rejects.toThrow('`fabrika.contract.ts` is not a regular file')
	})
})
