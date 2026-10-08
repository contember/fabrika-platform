/**
 * Resume support: persist captured secrets to a per-account env file, so an abort (or a crash) at ANY
 * point can be recovered by simply re-running — the second run picks every value back up and SKIPS
 * re-creating the external resources (GitHub App, vault key, provisioning key) that would otherwise be
 * orphaned with their secrets lost.
 *
 * The file is `$XDG_CONFIG_HOME/fabrika/cloudflare/<account>/.env` (0700 directory, 0600 file), NOT
 * `$PWD/.env`: it holds the Cloudflare account token, the vault KEK and IAM's signing key, and the cwd
 * is wherever the operator happened to be — routinely inside an unrelated repository. Living outside
 * every checkout also means Bun no longer auto-loads it, so `openEnvFile` loads it explicitly.
 *
 * Values are encoded so they survive Bun's `.env` loader exactly (see `encodeEnvValue`); `parseEnvFile`
 * is the matching decoder. This module NEVER logs a secret value — only the path and the KEY names.
 */

import { warn } from '@fabrika/installation-init'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Usable as one path segment: no separator, no traversal, no leading dash. */
const ACCOUNT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** This run's env file, bound by `openEnvFile` — the single source of the path. */
let envFilePath: string | undefined

/** `$XDG_CONFIG_HOME/fabrika/cloudflare/<account>`, falling back to `~/.config`. */
export function accountEnvDirectory(account: string): string {
	if (!ACCOUNT_SEGMENT.test(account)) {
		throw new Error(`Account ${account} cannot name a config directory — use letters, digits, dot, dash or underscore.`)
	}
	const configured = process.env['XDG_CONFIG_HOME']
	const root = configured !== undefined && configured !== '' && isAbsolute(configured) ? configured : join(homedir(), '.config')
	return join(root, 'fabrika', 'cloudflare', account)
}

/**
 * Bind this run's env file, creating its 0700 directory, and load what it already holds into
 * `process.env`. A value already present in the environment wins, matching Bun's own loader — which is
 * exactly why a stray `$PWD/.env` is called out: Bun loaded it before this ran, so ITS values outrank
 * the per-account file, and one left over from another account would be reused silently.
 */
export async function openEnvFile(account: string): Promise<string> {
	const directory = accountEnvDirectory(account)
	await mkdir(directory, { recursive: true, mode: 0o700 })
	await chmod(directory, 0o700)
	const cwdEnv = resolve(process.cwd(), '.env')
	if (existsSync(cwdEnv)) {
		warn(
			`${cwdEnv} exists and Bun already loaded it — its values OUTRANK ${account}'s installer env file, so one left over from`
				+ " another installation would be reused here. Move it away and re-run if it is not this account's.",
		)
	}
	const path = join(directory, '.env')
	const file = Bun.file(path)
	if (await file.exists()) {
		for (const [key, value] of Object.entries(parseEnvFile(await file.text()))) {
			const current = process.env[key]
			if (current === undefined || current === '') {
				process.env[key] = value
			}
		}
	}
	envFilePath = path
	return path
}

/** The absolute path of the env file being written (non-secret, printed once in the closing summary). */
export function envPath(): string {
	if (envFilePath === undefined) {
		throw new Error('The installer env file is not open yet — call openEnvFile(account) first.')
	}
	return envFilePath
}

/** Read an env var, returning undefined for unset OR empty. Dynamic access by design (no literal-key lint). */
export function fromEnv(name: string): string | undefined {
	const value = process.env[name]
	return value !== undefined && value !== '' ? value : undefined
}

/**
 * Upsert `KEY=value` into the env file (creating it if absent) and reflect it into the live `process.env`
 * so the rest of THIS run sees it too. An existing `KEY=` line (with or without a leading `export`) is
 * replaced in place; otherwise the line is appended. NEVER logs the value.
 */
export async function persistEnv(key: string, value: string): Promise<void> {
	await persistEnvBundle({ [key]: value })
}

/** Persist a related resume bundle with one same-filesystem atomic replacement. */
export async function persistEnvBundle(values: Readonly<Record<string, string>>): Promise<void> {
	await persistEnvBundleAt(envPath(), values)
	for (const [key, value] of Object.entries(values)) process.env[key] = value
}

/** Package-local test seam for the same atomic env-file replacement used in production. */
export async function persistEnvBundleAt(path: string, values: Readonly<Record<string, string>>): Promise<void> {
	const file = Bun.file(path)
	const existing = (await file.exists()) ? await file.text() : ''
	const lines = existing === '' ? [] : existing.split('\n')
	for (const [key, value] of Object.entries(values)) {
		const newLine = `${key}=${encodeEnvValue(value)}`
		const index = lines.findIndex((line) => stripExport(line).startsWith(`${key}=`))
		if (index >= 0) {
			lines[index] = newLine
		} else {
			while (lines.length > 0 && lines[lines.length - 1] === '') {
				lines.pop()
			}
			lines.push(newLine)
		}
	}
	const temporaryPath = join(dirname(path), `.env.${randomUUID()}.tmp`)
	const temporary = await open(temporaryPath, 'wx', 0o600)
	try {
		await temporary.writeFile(`${lines.join('\n')}\n`, 'utf8')
		await temporary.sync()
		await temporary.close()
		await rename(temporaryPath, path)
	} catch (error) {
		await temporary.close().catch(() => {})
		await rm(temporaryPath, { force: true }).catch(() => {})
		throw error
	}
}

/** Drop a leading `export ` so `KEY=` matching works whether or not the line is export-prefixed. */
function stripExport(line: string): string {
	return line.replace(/^\s*export\s+/, '')
}

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

/** Decode a whole env file written by `encodeEnvValue`. The inverse Bun used to perform for us. */
export function parseEnvFile(contents: string): Record<string, string> {
	const values: Record<string, string> = {}
	for (const line of contents.split('\n')) {
		const matched = ENV_LINE.exec(line)
		const key = matched?.[1]
		const encoded = matched?.[2]
		if (key === undefined || encoded === undefined) continue
		values[key] = decodeEnvValue(encoded)
	}
	return values
}

/** The inverse of `encodeEnvValue`; an unquoted value (hand-written) is taken verbatim. */
function decodeEnvValue(encoded: string): string {
	const value = encoded.trim()
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replace(/\\\$/g, '$')
	}
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\(n|\$)/g, (_: string, character: string) => (character === 'n' ? '\n' : '$'))
	}
	return value
}

/**
 * Encode a value so Bun's `.env` loader reads it back EXACTLY. Bun's quoting is quirky (all verified):
 *   - it expands `$VAR` / `${VAR}` in BOTH quote styles — so EVERY `$` is escaped to `\$` (a literal `$`),
 *   - double quotes re-expand `\n` (used for the PEM); single quotes keep `"`, `\`, backtick, `#`, spaces
 *     literal.
 * So: multi-line (only the GitHub App PEM) → double-quote + escape newlines; single-line → single-quote.
 * A single-line value cannot contain a literal `'` (Bun has no in-single-quote escape for it); a secret
 * with one is vanishingly rare, so we throw rather than silently corrupt it.
 */
function encodeEnvValue(value: string): string {
	const dollarSafe = value.replace(/\$/g, '\\$')
	if (/[\r\n]/.test(value)) {
		return `"${dollarSafe.replace(/\r/g, '').replace(/\n/g, '\\n')}"`
	}
	if (value.includes("'")) {
		throw new Error('Cannot safely persist a value containing a single quote to the env file — set it manually.')
	}
	return `'${dollarSafe}'`
}
