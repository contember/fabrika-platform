import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { POPLACH_SOURCE_COMMIT, POPLACH_SOURCE_INVENTORY } from '../../import/poplach-source-inventory.js'

const trackedPrefixes = ['src/', 'migrations/', 'seeds/', 'tests/browser/']

describe('Poplach source inventory', () => {
	test('accounts for the complete pinned source surface', async () => {
		expect(POPLACH_SOURCE_COMMIT).toBe('8e0c79d662c187fe41eacd0fee9fe77fde668f1f')
		expect(POPLACH_SOURCE_INVENTORY).toHaveLength(79)
		const paths = POPLACH_SOURCE_INVENTORY.map((entry) => entry.path)
		expect(new Set(paths).size).toBe(paths.length)
		expect(POPLACH_SOURCE_INVENTORY.every((entry) => entry.target.length > 0)).toBeTrue()
		expect(POPLACH_SOURCE_INVENTORY.every((entry) => trackedPrefixes.some((prefix) => entry.path.startsWith(prefix)))).toBeTrue()

		const poplachRoot = resolve(import.meta.dir, '../../../../../poplach')
		if (!existsSync(poplachRoot)) return
		const livePaths: string[] = []
		for await (const path of new Bun.Glob('**/*').scan({ cwd: poplachRoot, onlyFiles: true })) {
			if (trackedPrefixes.some((prefix) => path.startsWith(prefix))) livePaths.push(path)
		}
		expect([...paths].sort()).toEqual([...livePaths].sort())
	})
})
