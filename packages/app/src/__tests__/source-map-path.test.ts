import { describe, expect, test } from 'bun:test'
import { namesSourceMap } from '../source-map-path'

describe('namesSourceMap', () => {
	test('reads the path as the asset servers resolve it', () => {
		for (
			const path of ['/a.js.map', '/a.js.m%61p', '/a.js%2emap', '/a.js%2E%4D%41%50', '/a.js.map/', '/a.js.map//', '/x/a.js.MAP', '/a.js.Map', '/a.js%ZZ']
		) {
			expect([path, namesSourceMap(path)]).toEqual([path, true])
		}
	})

	test('leaves every other file, and a directory that only contains a map, to the asset server', () => {
		for (const path of ['/', '/a.js', '/map', '/a.mapping.js', '/notes.map/index.js', '/a.js.map.txt']) {
			expect([path, namesSourceMap(path)]).toEqual([path, false])
		}
	})
})
