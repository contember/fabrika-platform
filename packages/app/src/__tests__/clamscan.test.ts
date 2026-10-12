// The ClamAV scanner of the scan pass: how clamscan's answer becomes verdicts, and that every way a run can go wrong
// — no binary, a timeout, a flood of output, an object that cannot be read — gives no clean verdict. Stand-in
// binaries cover the failures; a REAL clamscan runs the rest when FABRIKA_TEST_CLAMSCAN_BIN names one (on PATH as
// `clamscan`, or a wrapper running the `clamav/clamav` image with the batch directory mounted at its own path).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clamscanArguments, clamscanScanner, clamscanVerdicts } from '../files/clamscan'
import type { ScanBatchResult, ScanObject } from '../files/scan'
import { CLEAN_PDF, EICAR, encryptedZip } from './fixtures/scan-samples'

const CLAMSCAN_VAR = 'FABRIKA_TEST_CLAMSCAN_BIN'
const clamscan = process.env[CLAMSCAN_VAR] ?? ''

if (clamscan === '') {
	console.warn(
		`clamscan.test.ts skipped its real-ClamAV half: set ${CLAMSCAN_VAR} to a clamscan binary, or to a wrapper that runs`
			+ ' `docker run --rm -v "$dir:$dir:ro" --entrypoint clamscan clamav/clamav:1.4 "$@"` with $dir the directory of its last argument',
	)
}

function object(id: string, bytes: Uint8Array<ArrayBuffer> | string): ScanObject {
	return { id, open: () => Promise.resolve(new Response(bytes).body ?? new ReadableStream()) }
}

const id = (): string => Bun.randomUUIDv7()

function verdicts(result: ScanBatchResult): ReadonlyMap<string, unknown> {
	if (!result.ok) {
		throw new Error(`the batch failed: ${result.failure}`)
	}
	return result.verdicts
}

describe("clamscan's answer", () => {
	const a = id()
	const b = id()
	const paths = new Map([[a, `/tmp/x/${a}`], [b, `/tmp/x/${b}`]])

	test('only an exact OK line is clean; a FOUND line names its signature; anything else is no verdict', () => {
		expect(verdicts(clamscanVerdicts(paths, 1, `/tmp/x/${a}: OK\n/tmp/x/${b}: Eicar-Test-Signature FOUND\n`, ''))).toEqual(
			new Map([[a, { kind: 'clean' }], [b, { kind: 'infected', signature: 'Eicar-Test-Signature' }]]),
		)
		expect(verdicts(clamscanVerdicts(paths, 0, `/tmp/x/${a}: Empty file\n/tmp/x/${b}: OK (but not quite)\n`, ''))).toEqual(
			new Map([[a, { kind: 'unscanned' }], [b, { kind: 'unscanned' }]]),
		)
	})

	test('a truncated answer leaves a file without a verdict, and a second line for one file makes it unscanned', () => {
		expect(verdicts(clamscanVerdicts(paths, 0, `/tmp/x/${a}: OK\n`, ''))).toEqual(new Map([[a, { kind: 'clean' }]]))
		expect(verdicts(clamscanVerdicts(paths, 1, `/tmp/x/${a}: OK\n/tmp/x/${a}: Eicar-Test-Signature FOUND\n`, '')).get(a)).toEqual({
			kind: 'unscanned',
		})
	})

	test('any other exit fails the whole batch, even with OK lines, by a fixed code', () => {
		const ok = `/tmp/x/${a}: OK\n`
		expect(clamscanVerdicts(paths, 2, `${ok}ERROR: Virus database is older than 3 days!\n`, '')).toEqual({ ok: false, failure: 'signatures_stale' })
		expect(clamscanVerdicts(paths, 2, '', 'LibClamAV Error: cl_load(): No such file or directory: /var/lib/clamav')).toEqual({
			ok: false,
			failure: 'signatures_missing',
		})
		expect(clamscanVerdicts(paths, 137, ok, '')).toEqual({ ok: false, failure: 'scanner_failed' })
	})

	test('every limit alerts instead of passing a file it could not read in full, and stale signatures fail the run', () => {
		const args = clamscanArguments('/var/lib/clamav', 1024)
		expect(args).toEqual(expect.arrayContaining([
			'--alert-encrypted=yes',
			'--alert-exceeds-max=yes',
			'--fail-if-cvd-older-than=3',
			'--max-filesize=1024',
			'--max-scansize=4096',
			'--max-recursion=10',
			'--database=/var/lib/clamav',
		]))
		expect(args.some((arg) => arg.startsWith('--max-scantime='))).toBe(true)
	})
})

describe('a clamscan run that does not complete gives no verdict', () => {
	let bin: string

	/** A stand-in clamscan: the shell script `body`. */
	async function standIn(name: string, body: string): Promise<string> {
		const path = join(bin, name)
		await Bun.write(path, `#!/bin/sh\n${body}\n`)
		await chmod(path, 0o755)
		return path
	}

	async function leftovers(directory: string): Promise<string[]> {
		return (await readdir(directory)).filter((entry) => entry.startsWith('fabrika-scan-'))
	}

	beforeAll(async () => {
		bin = await mkdtemp(join(tmpdir(), 'fabrika-clamscan-test-'))
	})

	afterAll(async () => {
		await rm(bin, { recursive: true, force: true })
	})

	test('no binary', async () => {
		const scanner = clamscanScanner({ binary: join(bin, 'absent'), directory: bin })
		expect(await scanner.scan([object(id(), CLEAN_PDF)], new AbortController().signal)).toEqual({ ok: false, failure: 'scanner_missing' })
	})

	test('a run past its deadline is killed, and its batch directory is removed', async () => {
		const scanner = clamscanScanner({ binary: await standIn('slow', 'sleep 30'), directory: bin, timeoutMs: 200 })
		const started = Date.now()
		expect(await scanner.scan([object(id(), CLEAN_PDF)], new AbortController().signal)).toEqual({ ok: false, failure: 'timeout' })
		expect(Date.now() - started).toBeLessThan(5_000)
		expect(await leftovers(bin)).toEqual([])
	})

	test('an aborted attempt stops the run', async () => {
		const scanner = clamscanScanner({ binary: await standIn('slow-abort', 'sleep 30'), directory: bin })
		const abort = new AbortController()
		setTimeout(() => abort.abort(), 100)
		expect(await scanner.scan([object(id(), CLEAN_PDF)], abort.signal)).toEqual({ ok: false, failure: 'timeout' })
	})

	test('a run that floods its output is stopped', async () => {
		const scanner = clamscanScanner({ binary: await standIn('noisy', 'yes OK | head -c 4000000'), directory: bin })
		expect(await scanner.scan([object(id(), CLEAN_PDF)], new AbortController().signal)).toEqual({ ok: false, failure: 'output_overflow' })
	})

	test('a file whose object cannot be read, or breaks off, is not handed to clamscan and gets no verdict', async () => {
		// Answers OK for every path it was given: what it never saw cannot come back clean.
		const scanner = clamscanScanner({
			binary: await standIn('agrees', 'for path; do case "$path" in /*) echo "$path: OK";; esac; done'),
			directory: bin,
		})
		const good = id()
		const missing = id()
		const truncated = id()
		const broken = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new TextEncoder().encode('%PDF-'))
				controller.error(new Error('the connection dropped'))
			},
		})
		const result = await scanner.scan([
			object(good, CLEAN_PDF),
			{ id: missing, open: () => Promise.reject(new Error('the object is missing')) },
			{ id: truncated, open: () => Promise.resolve(broken) },
		], new AbortController().signal)
		expect(verdicts(result)).toEqual(new Map([[good, { kind: 'clean' }]]))
		expect(await leftovers(bin)).toEqual([])
	})
})

describe.skipIf(clamscan === '')('a real clamscan', () => {
	test('EICAR is infected, a clean PDF is clean, an encrypted archive and an oversize file are never clean', async () => {
		const scanner = clamscanScanner({ binary: clamscan, maxFileBytes: 1024 })
		const [eicar, pdf, zip, big] = [id(), id(), id(), id()]
		const result = await scanner.scan([
			object(eicar, EICAR),
			object(pdf, CLEAN_PDF),
			object(zip, encryptedZip()),
			object(big, `${CLEAN_PDF}${' '.repeat(4096)}`),
		], new AbortController().signal)
		const found = verdicts(result)
		expect(found.get(eicar)).toEqual({ kind: 'infected', signature: expect.stringContaining('Eicar') })
		expect(found.get(pdf)).toEqual({ kind: 'clean' })
		expect(found.get(zip)).toEqual({ kind: 'infected', signature: expect.stringContaining('Encrypted') })
		expect(found.get(big)).toEqual({ kind: 'infected', signature: expect.stringContaining('Limits.Exceeded') })
	}, 120_000)

	test('a run that cannot load its signatures in time is a timed-out batch', async () => {
		const scanner = clamscanScanner({ binary: clamscan, timeoutMs: 1 })
		expect(await scanner.scan([object(id(), CLEAN_PDF)], new AbortController().signal)).toEqual({ ok: false, failure: 'timeout' })
	}, 60_000)
})
