/**
 * The per-account base repo `<org>/fabrika-platform`: which files it carries, and the one migration that
 * must stop a refresh. The create/clone/commit/push mechanics are shared
 * (`@fabrika/installation-init`); everything here is Cloudflare's answer to what gets written.
 *
 * `fabrika.ref` is written ONLY when absent (operator-owned after creation — bumping it is how you roll a new
 * base); `platform.yml` / `README.md` / `.gitignore` are CLI-owned and refreshed every run.
 */

import { INITIAL_SCAFFOLD_COMMIT_MESSAGE, REFRESH_SCAFFOLD_COMMIT_MESSAGE, scaffoldSidecarRepository } from '@fabrika/installation-init'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const TEMPLATES = resolve(import.meta.dir, 'templates')

/**
 * All scaffold files we ever `git add` (the CLI-owned trio + the operator-owned, write-once `fabrika.ref` pin).
 */
const ALL_FILES = ['.gitignore', 'README.md', 'fabrika.ref', '.github/workflows/platform.yml']
const LEGACY_REF_FILES = ['vozka.ref', 'propustka.ref']

export { INITIAL_SCAFFOLD_COMMIT_MESSAGE, REFRESH_SCAFFOLD_COMMIT_MESSAGE }

export interface ScaffoldInput {
	/** The base repo, e.g. `manGoweb/fabrika-platform`. */
	repo: string
	/** The account label (positional `init` arg) — substituted into the templates + the env/summary names. */
	account: string
	/** Local directory to check the repo out into. */
	dir: string
}

/** Result of scaffolding: the local checkout dir + whether the repo was freshly created. */
export interface ScaffoldResult {
	dir: string
	created: boolean
}

/** Render a template: replace every `{{ACCOUNT}}` token. (Account is the only placeholder today.) */
async function renderTemplate(name: string, account: string): Promise<string> {
	const raw = await Bun.file(resolve(TEMPLATES, name)).text()
	return raw.replaceAll('{{ACCOUNT}}', account)
}

/** Write the file at `rel` under `dir` with `content`, creating parent dirs as needed. */
async function writeFile(dir: string, rel: string, content: string): Promise<void> {
	await Bun.write(resolve(dir, rel), content)
}

/**
 * Materialize the CLI-owned files and the write-once source pin.
 *
 * Legacy two-repository pins need an operator-chosen merged-repository ref. Stop before writing anything
 * so a refresh cannot hide the migration requirement or delete operator-owned files.
 */
export async function materializePlatformScaffold(dir: string, account: string): Promise<void> {
	const legacyRefs = LEGACY_REF_FILES.filter((name) => existsSync(resolve(dir, name)))
	if (legacyRefs.length > 0) {
		throw new Error(
			`Legacy two-repository scaffold detected (${legacyRefs.join(', ')}). Choose the matching `
				+ 'contember/fabrika-platform commit or tag, write it to fabrika.ref, then remove the legacy '
				+ 'pin files manually and run `fabrika platform init --provider=cloudflare` again. '
				+ 'The CLI cannot infer the merged ref.',
		)
	}
	await writeFile(dir, '.gitignore', await Bun.file(resolve(TEMPLATES, 'gitignore')).text())
	await writeFile(dir, 'README.md', await renderTemplate('README.md', account))
	await writeFile(dir, '.github/workflows/platform.yml', await renderTemplate('platform.yml', account))
	if (!existsSync(resolve(dir, 'fabrika.ref'))) {
		await writeFile(dir, 'fabrika.ref', await Bun.file(resolve(TEMPLATES, 'fabrika.ref')).text())
	}
}

/**
 * Ensure `<org>/fabrika-platform` exists + carries the current scaffold. Returns the local checkout dir.
 * Requires `gh` authed with rights to create/admin the repo.
 */
export async function scaffoldPlatformRepo(input: ScaffoldInput): Promise<ScaffoldResult> {
	return scaffoldSidecarRepository({
		repo: input.repo,
		dir: input.dir,
		files: ALL_FILES,
		materialize: (dir) => materializePlatformScaffold(dir, input.account),
	})
}

/** The default local checkout dir for an account: `./fabrika-platform-<account>` under the cwd. */
export function defaultCheckoutDir(account: string): string {
	return resolve(process.cwd(), `fabrika-platform-${account}`)
}

/** Read the configured `fabrika.ref` (for display), or 'main' when absent. Used in the final summary. */
export async function readFabrikaRef(dir: string): Promise<string> {
	const file = Bun.file(resolve(dir, 'fabrika.ref'))
	if (!(await file.exists())) {
		return 'main'
	}
	return (await file.text()).trim() || 'main'
}
