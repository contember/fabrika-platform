import { createPage } from '@buzola/router'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import type { InstallationBrandDto } from '@fabrika/iam-contract'
import { type BrandImage, brandImageDataUri } from '@fabrika/proxy-core/brand'
import { useState } from 'react'
import { api as iam } from '../../access/lib/api'
import { BrandMark } from '../../components/Icon'
import { api, ApiError } from '../../lib/api'
import { type BrandDraft, chosenImage, draftImages, UNCHANGED_BRAND } from '../../lib/branding'
import { mayDo } from '../../lib/console-access'
import { fmtDate } from '../../lib/format'
import { consoleSession } from '../../lib/session'

/**
 * The installation's client logo (ADR-0066). IAM keeps it and shows it on its own pages at once; the proxy's pages on
 * every application host show it once each namespace's proxy is published again, which this page starts after a change
 * when the caller may republish namespaces. The console itself stays fabrika's.
 */
export default createPage()
	.loader(async () => {
		const [current, { access }] = await Promise.all([iam.brand.get(), consoleSession()])
		return { current, republishes: mayDo(access, CONTROL_ACTIONS.NAMESPACE_MANAGE) }
	})
	.route('/settings/branding')
	.render(({ data, invalidate }) => (
		<>
			<div className="page-head">
				<h1>Branding</h1>
				<p className="hint">
					The client's logo on the sign-in pages and on the error pages of every application. The console keeps fabrika's.
				</p>
			</div>
			<BrandingEditor current={data.current} republishes={data.republishes} onSaved={invalidate} />
		</>
	))

type Outcome =
	| { readonly kind: 'saved'; readonly namespaces: readonly string[] | null }
	| { readonly kind: 'unpublished'; readonly message: string }

export function BrandingEditor(
	{ current, republishes, onSaved }: { current: InstallationBrandDto; republishes: boolean; onSaved: () => void },
) {
	const [draft, setDraft] = useState<BrandDraft>(UNCHANGED_BRAND)
	const [errors, setErrors] = useState<{ light?: string; dark?: string }>({})
	const [busy, setBusy] = useState(false)
	const [failure, setFailure] = useState<string | null>(null)
	const [outcome, setOutcome] = useState<Outcome | null>(null)
	// A new key empties the file inputs once their files are saved.
	const [inputs, setInputs] = useState(0)
	const { light, dark, changed } = draftImages(current.brand, draft)

	async function choose(slot: 'light' | 'dark', file: File | undefined) {
		setOutcome(null)
		// A refused file takes back the one chosen before it: the slot keeps what is stored, never a file the admin replaced.
		setDraft((before) => slot === 'light' ? { ...before, light: 'stored' } : { ...before, dark: 'stored' })
		if (file === undefined) return
		const chosen = chosenImage(new Uint8Array(await file.arrayBuffer()), file.name, file.type)
		if (!chosen.ok) {
			setErrors((shown) => ({ ...shown, [slot]: chosen.message }))
			return
		}
		setErrors((shown) => ({ ...shown, [slot]: undefined }))
		setDraft((before) => slot === 'light' ? { ...before, light: chosen.image } : { ...before, dark: chosen.image })
	}

	/** Write the change to IAM, then publish it to the proxies: IAM's pages already show it, the proxies' do not yet. */
	async function apply(change: () => Promise<unknown>) {
		setBusy(true)
		setFailure(null)
		setOutcome(null)
		try {
			await change()
		} catch (cause) {
			setFailure(cause instanceof ApiError ? cause.message : 'The logo could not be saved.')
			setBusy(false)
			return
		}
		setDraft(UNCHANGED_BRAND)
		setInputs((key) => key + 1)
		try {
			const published = republishes ? await api.namespaces.republishAll() : null
			setOutcome({ kind: 'saved', namespaces: published === null ? null : published.namespaceIds })
		} catch (cause) {
			setOutcome({ kind: 'unpublished', message: cause instanceof ApiError ? cause.message : 'The application proxies were not republished.' })
		}
		setBusy(false)
		onSaved()
	}

	return (
		<>
			<section aria-labelledby="branding-preview">
				<h2 id="branding-preview">{changed ? 'Preview' : 'Current logo'}</h2>
				<div className="brand-preview">
					<BrandTile scheme="light" image={light} />
					<BrandTile scheme="dark" image={dark ?? light} />
				</div>
				{current.updatedAt !== null && !changed && <p className="hint">Changed {fmtDate(current.updatedAt)}.</p>}
			</section>

			<section aria-labelledby="branding-change">
				<h2 id="branding-change">Change the logo</h2>
				<form
					key={inputs}
					className="form"
					onSubmit={(event) => {
						event.preventDefault()
						if (light === null || !changed) return
						void apply(() => iam.brand.set({ brand: { light, ...(dark === null ? {} : { dark }) } }))
					}}
				>
					<label>
						Logo for light pages<input
							id="branding-light"
							type="file"
							accept="image/png,image/webp,image/svg+xml,.png,.webp,.svg"
							onChange={(event) => void choose('light', event.target.files?.[0])}
						/>
						<span className="hint">PNG, WebP or SVG, at most 32 KB. A wide wordmark and a square symbol both fit.</span>
					</label>
					{errors.light !== undefined && <p className="error-text" role="alert">{errors.light}</p>}
					<label>
						Logo for dark pages (optional)<input
							id="branding-dark"
							type="file"
							accept="image/png,image/webp,image/svg+xml,.png,.webp,.svg"
							onChange={(event) => void choose('dark', event.target.files?.[0])}
						/>
						<span className="hint">Without it, the light logo stands on dark pages as it is.</span>
					</label>
					{errors.dark !== undefined && <p className="error-text" role="alert">{errors.dark}</p>}
					{light === null && dark !== null && <p className="hint">Choose a logo for light pages too: every logo has one.</p>}
					{failure !== null && <p className="error-text" role="alert">{failure}</p>}
					<div className="form-actions">
						<button className="primary" type="submit" disabled={busy || light === null || !changed}>{busy ? 'Saving…' : 'Save logo'}</button>
						{dark !== null && (
							<button
								className="ghost"
								type="button"
								disabled={busy}
								onClick={() => setDraft((before) => ({ ...before, dark: current.brand?.dark === undefined ? 'stored' : null }))}
							>
								Use the light logo on dark pages
							</button>
						)}
						{current.brand !== null && (
							<button className="danger" type="button" disabled={busy} onClick={() => void apply(() => iam.brand.clear())}>
								Remove logo
							</button>
						)}
					</div>
				</form>
				{outcome !== null && <OutcomeNotice outcome={outcome} />}
			</section>
		</>
	)
}

function OutcomeNotice({ outcome }: { outcome: Outcome }) {
	if (outcome.kind === 'unpublished') {
		return (
			<p className="notice notice-bad" role="alert">
				Saved. The sign-in pages show it now, but the application proxies were not republished: {outcome.message}
			</p>
		)
	}
	if (outcome.namespaces === null) {
		return (
			<p className="notice" role="status">
				Saved. The sign-in pages show it now. The error pages of applications show it once someone who manages namespaces republishes them.
			</p>
		)
	}
	return (
		<p className="notice" role="status">
			Saved. The sign-in pages show it now; the error pages of applications in {outcome.namespaces.length}{' '}
			{outcome.namespaces.length === 1 ? 'namespace' : 'namespaces'} once their proxy rebuild finishes, in a few minutes.
		</p>
	)
}

/** The grid of fabrika's pages as a light or a dark page draws it, with the logo or, without one, the fabrika mark. */
function BrandTile({ scheme, image }: { scheme: 'light' | 'dark'; image: BrandImage | null }) {
	return (
		<figure className="brand-tile" data-scheme={scheme}>
			<div className="brand-tile-art">{image === null ? <BrandMark size={56} /> : <img src={brandImageDataUri(image)} alt="" />}</div>
			<figcaption>{scheme === 'light' ? 'Light pages' : 'Dark pages'}</figcaption>
		</figure>
	)
}
