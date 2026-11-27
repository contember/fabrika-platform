// What the operator's sidecar repository for an AWS installation contains (ADR-0025): a workflow that takes the
// deployer role (`deployer.ts`) and runs `fabrika platform upgrade --provider=aws` at a pinned tag, its README, a
// `.gitignore`, and `fabrika.ref`. The shape is Zerops' (`provider-zerops`'s `sidecar.ts`); no provider imports
// another's, so the little it shares is written again here.
//
// - **The workflow, the README and the `.gitignore` are the CLI's**, rewritten by every `init`, so a fix to the
//   generated pipeline reaches an installation on its operator's next run.
// - **`fabrika.ref` is the operator's**: written only when absent, since bumping it is how an installation is
//   upgraded, and a refresh that reset it would roll it back. An existing one is checked to be a tag, as the workflow
//   checks again at run time.
// - **No secret.** The workflow reads the role's ARN, the account, the region and the base image from the GitHub
//   Environment's variables; the credentials are the role's, taken through GitHub's OIDC provider for one run.

import { assertPinnedTag } from '@fabrika/installation-init'
import { resolve } from 'node:path'

const TEMPLATES = resolve(import.meta.dir, 'templates')

/** The file that pins which published fabrika tag this installation runs. */
export const FABRIKA_REF_FILE = 'fabrika.ref'
/** The generated pipeline, CLI-owned. */
export const SIDECAR_WORKFLOW_PATH = '.github/workflows/platform.yml'
/** Everything the scaffold stages: the CLI-owned three and the operator's write-once pin. */
export const AWS_SIDECAR_FILES: readonly string[] = ['.gitignore', 'README.md', FABRIKA_REF_FILE, SIDECAR_WORKFLOW_PATH]

/** What a sidecar is rendered for. */
export interface AwsSidecarValues {
	/** `<owner>/<name>` of the sidecar repository. */
	readonly repo: string
	readonly accountId: string
	readonly region: string
	/** The GitHub Environment the workflow runs in: the installation's environment name. */
	readonly environment: string
	/** The deployer role the workflow takes, named in its comment (the Environment's variable is what it reads). */
	readonly roleArn: string
	/** The published fabrika tag to pin, written only when `fabrika.ref` does not exist yet. */
	readonly fabrikaRef: string
}

/** A template with every placeholder replaced. GitHub's own `${{ … }}` expressions hold none of these names. */
async function render(name: string, values: AwsSidecarValues): Promise<string> {
	const raw = await Bun.file(resolve(TEMPLATES, name)).text()
	return raw
		.replaceAll('{{REPO}}', values.repo)
		.replaceAll('{{ACCOUNT_ID}}', values.accountId)
		.replaceAll('{{REGION}}', values.region)
		.replaceAll('{{ENVIRONMENT}}', values.environment)
		.replaceAll('{{ROLE_ARN}}', values.roleArn)
}

/** The generated workflow for one installation. */
export function renderAwsSidecarWorkflow(values: AwsSidecarValues): Promise<string> {
	return render('platform.yml', values)
}

/** Writes the sidecar's files into `dir`: the CLI's three always, `fabrika.ref` only when absent. */
export async function materializeAwsSidecar(dir: string, values: AwsSidecarValues): Promise<void> {
	assertPinnedTag(values.fabrikaRef)
	const pin = Bun.file(resolve(dir, FABRIKA_REF_FILE))
	const existing = (await pin.exists()) ? (await pin.text()).trim() : undefined
	if (existing !== undefined) assertPinnedTag(existing)
	await Bun.write(resolve(dir, '.gitignore'), await Bun.file(resolve(TEMPLATES, 'gitignore')).text())
	await Bun.write(resolve(dir, 'README.md'), await render('README.md', values))
	await Bun.write(resolve(dir, SIDECAR_WORKFLOW_PATH), await renderAwsSidecarWorkflow(values))
	if (existing === undefined) await Bun.write(resolve(dir, FABRIKA_REF_FILE), `${values.fabrikaRef}\n`)
}

/** The tag a checkout pins, or `''` when it has none. */
export async function readAwsPinnedTag(dir: string): Promise<string> {
	const file = Bun.file(resolve(dir, FABRIKA_REF_FILE))
	return (await file.exists()) ? (await file.text()).trim() : ''
}
