#!/usr/bin/env bun

import { cmdAdvance } from './commands/advance'
import { cmdBuild } from './commands/build'
import { cmdEnsureDaemon } from './commands/ensure-daemon'
import { cmdGate } from './commands/gate'
import { cmdInduce } from './commands/induce'
import { cmdInit } from './commands/init'
import { cmdNext } from './commands/next'
import { cmdPlatform } from './commands/platform'
import { BuilderCliError } from './errors'

export const BUILDER_USAGE = `fabrika builder — guided application builder

Usage:
  fabrika builder init [dir] [--profile <stack>] [--agent all|claude|codex]
                       [--session=<id>] [--no-open] [--no-daemon] [--json]
                                               Scaffold .fabrika/, install agent support, open dashboard
  fabrika builder next [--json]                      Print the task packet for the current derived phase
  fabrika builder init [dir] --url=<origin> [--no-open]  Initialize zerops-app and begin human consent
                         [--no-daemon]               Offline init only; incompatible with --url
  fabrika builder connect --url=<origin> [--no-open] [--json]
  fabrika builder status [--json]                    Read connection and deployment status
  fabrika builder disconnect [--json]                Remove local custody; revoke separately in console
  fabrika builder deploy [--wait] [--timeout=<seconds>] [--json]
  fabrika builder preview --url=<url> | --clear [--json]
                                                    Platform commands also accept --dir=<project>
                                                    Results are sanitized JSON; wait defaults to 600 seconds
                                                    --no-open returns the local dashboard URL, never approval proof
                                                    All commands accept --help and never prompt for input
  fabrika builder advance [--force]                  Validate outputs and gate, then print the next phase
  fabrika builder gate open <name> --view <f.jsx>    Push a canvas gate and open the dashboard
  fabrika builder gate wait [--gate <n>] [--timeout] Wait for submitted gate feedback
  fabrika builder ensure-daemon                      Start the daemon if it is not running
  fabrika builder induce [--force]                   Derive issues from opice skeleton metadata
  fabrika builder build [--issue <ID>] [--assisted]  Run the assisted per-issue build driver

Environment:
  FABRIKA_PORT         Daemon port (default 19410)
  FABRIKA_SESSION_ID   Session id (fallback: stable hash of repo abs path)
  FABRIKA_DATA_DIR     Persistent daemon/session data (default ~/.fabrika; legacy auto-detected)
  FABRIKA_TIMEOUT      gate wait timeout in ms (default 3600000)`

export async function runBuilderCli(argv: readonly string[]): Promise<number> {
	try {
		return await dispatchBuilderCli(argv)
	} catch (error) {
		console.error(
			error instanceof BuilderCliError
				? error.message
				: 'Builder command failed. Check arguments, .fabrika/config.json, and the local dashboard; use --help for usage.',
		)
		return 1
	}
}

async function dispatchBuilderCli(argv: readonly string[]): Promise<number> {
	const command = argv[0]
	const rest = argv.slice(1)

	if (!command || command === '--help' || command === '-h' || command === 'help' || rest.includes('--help') || rest.includes('-h')) {
		console.info(BUILDER_USAGE)
		return command ? 0 : 1
	}

	switch (command) {
		case 'connect':
		case 'status':
		case 'disconnect':
		case 'deploy':
		case 'preview':
			return cmdPlatform(command, rest)
		case 'init':
			return cmdInit(rest)
		case 'next':
			return cmdNext(rest)
		case 'advance':
			return cmdAdvance(rest)
		case 'gate':
			return cmdGate(rest)
		case 'ensure-daemon':
			return cmdEnsureDaemon(rest)
		case 'induce':
			return cmdInduce(rest)
		case 'build':
			return cmdBuild(rest)
		default:
			console.error(`Unknown builder command: ${command}`)
			console.info(BUILDER_USAGE)
			return 1
	}
}

if (import.meta.main) {
	runBuilderCli(process.argv.slice(2)).then((code) => process.exit(code)).catch((error: unknown) => {
		console.error(error instanceof Error ? error.stack ?? error.message : String(error))
		process.exit(1)
	})
}
