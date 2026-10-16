// What the operator's sidecar repository contains, and the one rule about its pin.
//
// ── Why a sidecar repository at all ───────────────────────────────────────────────────────────────
//
// [ADR-0025](../../../docs/decisions/0025-the-operator-installs-the-platform-fabrika-deploys-apps.md):
// a pipeline that deploys an installation needs write access to that installation's cloud account, and
// this is ONE public repository installed by many operators. So the pipeline cannot live here. fabrika
// ships the generator; the operator owns the pipeline, its GitHub Environment, and the credentials in
// it.
//
// ── The pin is a TAG, and this file is where that is enforced twice ───────────────────────────────
//
// `fabrika.ref` names a published tag of `contember/fabrika-platform`, never a branch: a namespace
// proxy and an installation both build from tags, so a moving ref would make "which version is this
// installation running" unanswerable. `assertPinnedTag` refuses a branch when init writes the file, and
// the generated workflow refuses one again at run time — two gates, because the file is operator-owned
// after creation and the second gate is the only one that sees what the operator later wrote.
//
// ── The templates are not Cloudflare's ────────────────────────────────────────────────────────────
//
// The shape is the same (a workflow, a ref, a README, a `.gitignore`) and almost nothing else is.
// Cloudflare's workflow runs three deploy stages because on that provider the ORDER lives in the
// pipeline; this one runs a single step because on Zerops the order is inside the command (ADR-0027).
// Cloudflare builds a runner image and needs a GitHub App; Zerops has no runner at all (ADR-0003).

import { resolve } from 'node:path'
import { z } from 'zod'

const TEMPLATES = resolve(import.meta.dir, 'templates')

/** Everything the scaffold stages: the CLI-owned trio plus the operator-owned, write-once pin. */
export const SIDECAR_FILES = ['.gitignore', 'README.md', 'fabrika.ref', '.github/workflows/platform.yml'] as const

/** The file that pins which published fabrika tag this installation runs. */
export const FABRIKA_REF_FILE = 'fabrika.ref'

/** The generated pipeline. CLI-owned: `init` and `upgrade` both rewrite it. */
export const SIDECAR_WORKFLOW_PATH = '.github/workflows/platform.yml'

/** What a rendered sidecar repository is named after. */
export interface SidecarValues {
	/** The operator's name for this installation. The GitHub Environment is named after it too. */
	readonly installation: string
	/** `<owner>/<name>` of the sidecar repository itself. */
	readonly repo: string
	/** The published fabrika tag to pin, used only when `fabrika.ref` does not exist yet. */
	readonly fabrikaRef: string
}

/**
 * A published release tag: `v` and a semantic version.
 *
 * The same shape `scripts/release.ts` accepts, restated rather than imported — that script is not a
 * package and this check has to hold in a published tarball.
 */
const TAG_PATTERN = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** The pinned ref, or an error naming what was found. A branch is refused, deliberately and loudly. */
export const assertPinnedTag = (ref: string): string => {
	const trimmed = ref.trim()
	if (trimmed === '') {
		throw new Error('a published fabrika tag is required, for example v0.1.0')
	}
	if (!TAG_PATTERN.test(trimmed)) {
		throw new Error(
			`\`${trimmed}\` is not a published tag. A sidecar repository pins a TAG such as v0.1.0 and never a branch: `
				+ 'an installation that tracked a moving ref could not say which version it runs (ADR-0025)',
		)
	}
	return trimmed
}

/** Substitute every placeholder in a template. */
const render = async (name: string, values: SidecarValues): Promise<string> => {
	const raw = await Bun.file(resolve(TEMPLATES, name)).text()
	return raw
		.replaceAll('{{INSTALLATION}}', values.installation)
		.replaceAll('{{REPO}}', values.repo)
		.replaceAll('{{FABRIKA_REF}}', values.fabrikaRef)
}

/** The generated pipeline for one installation. Its only placeholder is the installation, which names its GitHub Environment. */
export const renderSidecarWorkflow = async (installation: string): Promise<string> =>
	(await Bun.file(resolve(TEMPLATES, 'platform.yml')).text()).replaceAll('{{INSTALLATION}}', installation)

const sidecarWorkflowSchema = z.object({ jobs: z.object({ deploy: z.object({ environment: z.string().trim().min(1) }) }) })

/**
 * The installation a sidecar's current workflow was rendered for, read back from its GitHub Environment.
 *
 * Not from the repository name: `init --repo` accepts any name, and a workflow rendered for the wrong
 * Environment deploys with no credentials.
 */
export const readSidecarWorkflowInstallation = async (dir: string): Promise<string> => {
	const regenerate = 'run `fabrika platform init --provider=zerops <installation>` to regenerate it'
	const file = Bun.file(resolve(dir, SIDECAR_WORKFLOW_PATH))
	if (!(await file.exists())) {
		throw new Error(`${dir} has no ${SIDECAR_WORKFLOW_PATH} — ${regenerate}`)
	}
	let document: unknown
	try {
		document = Bun.YAML.parse(await file.text())
	} catch {
		throw new Error(`${dir}/${SIDECAR_WORKFLOW_PATH} is not valid YAML — ${regenerate}`)
	}
	const parsed = sidecarWorkflowSchema.safeParse(document)
	if (!parsed.success) {
		throw new Error(`${dir}/${SIDECAR_WORKFLOW_PATH} names no \`jobs.deploy.environment\` — ${regenerate}`)
	}
	return parsed.data.jobs.deploy.environment
}

const write = async (dir: string, rel: string, content: string): Promise<void> => {
	await Bun.write(resolve(dir, rel), content)
}

/**
 * Write the sidecar files into `dir`.
 *
 * The workflow, the README and the `.gitignore` are CLI-owned and refreshed on every run, so a fix to
 * the generated pipeline reaches every installation on its operator's next `init` (and the workflow on
 * the next `upgrade`). `fabrika.ref` is
 * written ONLY when absent: bumping it is how an operator rolls the installation forward, and a refresh
 * that reset it would silently roll them back.
 *
 * An existing `fabrika.ref` is validated rather than ignored — a sidecar that has drifted onto a branch
 * is exactly the case the two gates exist for, and finding it here beats finding it in a failed run.
 */
export const materializeSidecarScaffold = async (dir: string, values: SidecarValues): Promise<void> => {
	assertPinnedTag(values.fabrikaRef)
	const pin = Bun.file(resolve(dir, FABRIKA_REF_FILE))
	const existing = (await pin.exists()) ? (await pin.text()).trim() : undefined
	if (existing !== undefined) {
		assertPinnedTag(existing)
	}
	await write(dir, '.gitignore', await Bun.file(resolve(TEMPLATES, 'gitignore')).text())
	await write(dir, 'README.md', await render('README.md', values))
	await write(dir, SIDECAR_WORKFLOW_PATH, await renderSidecarWorkflow(values.installation))
	if (existing === undefined) {
		await write(dir, FABRIKA_REF_FILE, await render('fabrika.ref', values))
	}
}

/** The pin a checkout carries, for the closing summary. */
export const readPinnedTag = async (dir: string): Promise<string> => {
	const file = Bun.file(resolve(dir, FABRIKA_REF_FILE))
	return (await file.exists()) ? (await file.text()).trim() : ''
}

/**
 * The default sidecar repository for an installation, following the predecessor's `vozka-platform-<account>`
 * precedent: named so its relation to the installation is obvious. A parameter, never a constant — one
 * operator's installations are not another's.
 */
export const defaultSidecarRepo = (installation: string): string => `contember/fabrika-zerops-${installation}`

/** Where the sidecar is checked out locally: `./fabrika-zerops-<installation>` under the cwd. */
/** The sidecar checkout's directory name when `--checkout` is not given; `init` creates it and `upgrade` reads it. */
export const defaultCheckoutName = (installation: string): string => `fabrika-zerops-${installation}`

export const defaultCheckoutDir = (installation: string): string => resolve(process.cwd(), defaultCheckoutName(installation))
