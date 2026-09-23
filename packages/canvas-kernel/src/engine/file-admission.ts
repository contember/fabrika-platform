import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'

export type AssertReadable = (path: string) => void

export class CanvasFileAdmissionError extends Error {
	constructor() {
		super('Canvas file access refused')
	}
}

export function assertCanvasFileReadable(path: string, assertReadable?: AssertReadable): void {
	if (!assertReadable) return
	try {
		assertReadable(resolve(path))
		assertReadable(realpathSync(path))
	} catch {
		throw new CanvasFileAdmissionError()
	}
}

export function readCanvasFile(path: string, assertReadable?: AssertReadable): string {
	assertCanvasFileReadable(path, assertReadable)
	return readFileSync(path, 'utf-8')
}
