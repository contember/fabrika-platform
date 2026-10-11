// The launcher's own protection: a process that holds the provisioning credential marks itself non-dumpable before it
// starts the application, so a process of the same user, the application among them, cannot read its
// `/proc/<pid>/environ` or `/proc/<pid>/mem`. Linux only; elsewhere is a development machine.

import { dlopen, FFIType } from 'bun:ffi'

/** `PR_SET_DUMPABLE` from `<linux/prctl.h>`. */
const PR_SET_DUMPABLE = 4

/** The C library of a glibc system, then Alpine's musl one. */
const libraries = (): readonly string[] => [
	'libc.so.6',
	`libc.musl-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}.so.1`,
]

function prctl(): (option: number, value: number) => number {
	for (const library of libraries()) {
		try {
			const { symbols } = dlopen(library, {
				prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
			})
			return (option, value) => symbols.prctl(option, value, 0, 0, 0)
		} catch {
			// The next candidate.
		}
	}
	throw new Error('the launcher found no C library to call prctl in')
}

/**
 * Makes this process non-dumpable. On Linux a failure throws: the launcher must not start the application readable.
 * Elsewhere it warns once and returns, because no deployment runs there.
 */
export function makeProcessUndumpable(): void {
	if (process.platform !== 'linux') {
		console.warn(`fabrika: ${process.platform} has no prctl; the launcher stays readable by processes of the same user (development only)`)
		return
	}
	if (prctl()(PR_SET_DUMPABLE, 0) !== 0) {
		throw new Error('the launcher could not make itself non-dumpable (prctl PR_SET_DUMPABLE)')
	}
}
