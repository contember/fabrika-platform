/**
 * The per-account base repo `<org>/fabrika-platform`: which files it carries, and the one migration that
 * must stop a refresh. The create/clone/commit/push mechanics are shared
 * (`@fabrika/installation-init`); everything here is Cloudflare's answer to what gets written.
 *
 * `fabrika.ref` is written ONLY when absent (operator-owned after creation — bumping it is how you roll a new
 * base); `platform.yml` / `README.md` / `.gitignore` are CLI-owned and refreshed every run.
 */

import { builtinEmailProviders, builtinEmailProviderVariables } from '@fabrika/email/providers'
import {
	INITIAL_SCAFFOLD_COMMIT_MESSAGE,
	type ProtectionOutcome,
	REFRESH_SCAFFOLD_COMMIT_MESSAGE,
	scaffoldSidecarRepository,
} from '@fabrika/installation-init'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { GitHubSecretsMode } from './init-options'

const TEMPLATES = resolve(import.meta.dir, 'templates')

/**
 * All scaffold files we ever `git add` (the CLI-owned trio + the operator-owned, write-once `fabrika.ref` pin).
 */
const ALL_FILES = ['.gitignore', 'README.md', 'fabrika.ref', '.github/workflows/platform.yml']
const LEGACY_REF_FILES = ['vozka.ref', 'propustka.ref']

export { INITIAL_SCAFFOLD_COMMIT_MESSAGE, REFRESH_SCAFFOLD_COMMIT_MESSAGE }

export interface ScaffoldInput {
	/** The base repo, e.g. `acme/fabrika-platform`. */
	repo: string
	/** The account label (positional `init` arg) — substituted into the templates + the env/summary names. */
	account: string
	/** Local directory to check the repo out into. */
	dir: string
	/** Where the workflow's secrets and variables live: the account's Environment, or the repository itself. */
	githubSecrets: GitHubSecretsMode
}

/** Result of scaffolding: the local checkout dir + whether the repo was freshly created. */
export interface ScaffoldResult {
	dir: string
	created: boolean
	/** Set only for a repository this run created; absent means an existing repo was left as it is. */
	branchProtection?: ProtectionOutcome
}

/**
 * A section only one GitHub secrets mode renders: everything between a `{{#environment}}` (or `{{#repository}}`) line
 * and its closing `{{/environment}}` line. A marker line may be a YAML comment (`# {{#environment}}`), so the
 * workflow template stays valid YAML. The marker lines themselves never reach the output.
 */
const MODE_SECTION = /^ *(?:# )?\{\{#(environment|repository)\}\}\n([\s\S]*?)^ *(?:# )?\{\{\/\1\}\}\n/gm

/**
 * Render a template: keep the sections of `mode`, replace every `{{ACCOUNT}}` token and `{{GH_SCOPE}}` (the `gh`
 * flag that names where a secret lives: ` --env <account>`, or nothing for the repository), and the mail
 * placeholders with the built-in providers, so a provider added to the registry reaches the workflow and the README
 * without a template edit.
 */
async function renderTemplate(name: string, account: string, mode: GitHubSecretsMode): Promise<string> {
	const raw = await Bun.file(resolve(TEMPLATES, name)).text()
	return raw
		.replaceAll(MODE_SECTION, (_section, sectionMode: string, body: string) => sectionMode === mode ? body : '')
		.replaceAll('{{GH_SCOPE}}', () => mode === 'environment' ? ` --env ${account}` : '')
		.replaceAll('{{ACCOUNT}}', () => account)
		.replaceAll('{{EMAIL_PROVIDER_NAMES}}', () => Object.keys(builtinEmailProviders).join('|'))
		.replaceAll(/^\{\{EMAIL_PROVIDER_VARIABLES\}\}$/gm, () => emailProviderVariablesList())
		.replaceAll(/^( *)# \{\{EMAIL_PROVIDER_ENV\}\}$/gm, (_line, indent: string) => emailProviderEnv(indent))
}

/** Each provider's variables, a credential from the Environment's secrets and the rest from its variables. */
function emailProviderEnv(indent: string): string {
	return builtinEmailProviderVariables
		.map((variable) => `${indent}${variable.name}: \${{ ${variable.secret ? 'secrets' : 'vars'}.${variable.name} }}`)
		.join('\n')
}

/** The README's list: one line per provider, naming its variables and how each is stored. */
function emailProviderVariablesList(): string {
	return Object.entries(builtinEmailProviders)
		.map(([name, provider]) => {
			const variables = provider.variables.map((variable) =>
				`\`${variable.name}\` (${variable.secret ? 'secret' : 'variable'}${variable.required ? '' : ', optional'})`
			)
			return `- \`${name}\`: ${variables.join(', ')}`
		})
		.join('\n')
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
export async function materializePlatformScaffold(dir: string, account: string, mode: GitHubSecretsMode = 'environment'): Promise<void> {
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
	await writeFile(dir, 'README.md', await renderTemplate('README.md', account, mode))
	await writeFile(dir, '.github/workflows/platform.yml', await renderTemplate('platform.yml', account, mode))
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
		materialize: (dir) => materializePlatformScaffold(dir, input.account, input.githubSecrets),
	})
}

/** Read the configured `fabrika.ref` (for display), or 'main' when absent. Used in the final summary. */
export async function readFabrikaRef(dir: string): Promise<string> {
	const file = Bun.file(resolve(dir, 'fabrika.ref'))
	if (!(await file.exists())) {
		return 'main'
	}
	return (await file.text()).trim() || 'main'
}
