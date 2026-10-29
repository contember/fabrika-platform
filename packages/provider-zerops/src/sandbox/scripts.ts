// The helper scripts every deploy uploads into a sandbox (`packages/provider-zerops/sandbox/bin/`), under a directory
// named by their hash: a fix reaches every existing sandbox with its next deploy, without a new base image.

import { contentVersion, readSandboxFiles } from './base-image'
import { SANDBOX_BIN_DIR } from './constants'

export const SANDBOX_SCRIPT_FILES = ['postgres-auth.sh', 'reset.sh', 'run-build.sh', 'run-launcher.sh', 'start-launcher.sh', 'stop.sh'] as const

export type SandboxScript = (typeof SANDBOX_SCRIPT_FILES)[number]

export interface SandboxScripts {
	readonly version: string
	readonly files: Readonly<Record<string, Uint8Array>>
	/** The absolute path of a script of this version inside a sandbox. */
	path(script: SandboxScript): string
}

export function sandboxScripts(files: Readonly<Record<string, Uint8Array>>): SandboxScripts {
	const version = contentVersion(files)
	return { version, files, path: (script) => `${SANDBOX_BIN_DIR}/${version}/${script}` }
}

/** The scripts this package ships. */
export async function readSandboxScripts(): Promise<SandboxScripts> {
	return sandboxScripts(await readSandboxFiles('./bin/', SANDBOX_SCRIPT_FILES))
}
