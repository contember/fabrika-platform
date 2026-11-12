import { useFeedback } from '#canvas/runtime'
import { useEffect, useState } from 'react'
import { deleteLocalAsset, listLocalAssets, MODE, type StoredAsset, uploadLocalAsset } from '../clientApi'

const FIELD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** The daemon's own per-file limit; a canvas may set a lower one. */
const DAEMON_MAX_BYTES = 25 * 1024 * 1024

interface FileDropProps {
	id: string
	label: string
	/** File types the picker offers, as in `<input accept>`. A hint for the picker, not a check. */
	accept?: string
	/** Largest file accepted, in bytes. */
	maxBytes?: number
	required?: boolean
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Files the user hands the agent. The daemon keeps them with the session; the feedback names their paths. */
export function FileDrop({ id, label, accept, maxBytes, required }: FileDropProps) {
	const [files, setFiles] = useState<StoredAsset[]>([])
	const [busy, setBusy] = useState(!MODE.isShared)
	const [error, setError] = useState<string | null>(null)
	const [dragging, setDragging] = useState(false)
	const validFieldId = FIELD_ID_RE.test(id)
	const locallyAvailable = !MODE.isShared
	const limit = Math.min(maxBytes ?? DAEMON_MAX_BYTES, DAEMON_MAX_BYTES)

	useEffect(() => {
		if (!locallyAvailable || !validFieldId) {
			setBusy(false)
			return
		}
		let active = true
		listLocalAssets(id)
			.then((stored) => {
				if (active) setFiles(stored)
			})
			.catch((cause: unknown) => {
				if (active) setError(cause instanceof Error ? cause.message : 'Could not read the files')
			})
			.finally(() => {
				if (active) setBusy(false)
			})
		return () => {
			active = false
		}
	}, [id, locallyAvailable, validFieldId])

	const feedback = files.length === 0
		? ''
		: `**${label}**\n${files.map((file) => `- \`${file.path}\` (${file.name}, ${formatSize(file.size)})`).join('\n')}\n`
	useFeedback(`files:${id}`, feedback, { label, required: required && locallyAvailable })

	const add = async (picked: readonly File[]) => {
		const tooLarge = picked.filter((file) => file.size > limit)
		if (tooLarge.length > 0) {
			setError(`${tooLarge.map((file) => file.name).join(', ')}: larger than ${formatSize(limit)}`)
			return
		}
		setBusy(true)
		setError(null)
		try {
			for (const file of picked) {
				const stored = await uploadLocalAsset(id, file)
				setFiles((current) => [...current, stored])
			}
		} catch (cause: unknown) {
			setError(cause instanceof Error ? cause.message : 'Could not upload the file')
		} finally {
			setBusy(false)
		}
	}

	const remove = async (file: StoredAsset) => {
		setBusy(true)
		setError(null)
		try {
			await deleteLocalAsset(id, file.id)
			setFiles((current) => current.filter((candidate) => candidate.id !== file.id))
		} catch (cause: unknown) {
			setError(cause instanceof Error ? cause.message : 'Could not remove the file')
		} finally {
			setBusy(false)
		}
	}

	const inputId = `file-drop-${id}`
	return (
		<div data-md="filedrop" data-md-label={label} className="-mx-4 px-4 py-3 my-1 rounded-lg">
			<div className="flex items-baseline gap-2 mb-2">
				<label htmlFor={inputId} className="text-[13px] font-body font-medium text-text-primary">{label}</label>
				{required && <span className="text-[10px] text-accent-red font-body">*</span>}
			</div>
			{!validFieldId && <p className="text-[12px] text-accent-red font-body">Invalid field ID.</p>}
			{!locallyAvailable && <p className="text-[12px] text-text-tertiary font-body">Files can be added only on the canvas author's machine.</p>}
			{locallyAvailable && validFieldId && (
				<div
					onDragOver={(event) => {
						event.preventDefault()
						setDragging(true)
					}}
					onDragLeave={() => setDragging(false)}
					onDrop={(event) => {
						event.preventDefault()
						setDragging(false)
						void add([...(event.dataTransfer?.files ?? [])])
					}}
					className={`rounded-lg border border-dashed px-3 py-4 text-center text-[13px] font-body ${
						dragging ? 'border-accent-blue bg-accent-blue-muted' : 'border-border-medium bg-bg-input'
					}`}
				>
					<span className="text-text-secondary">Drop files here or</span>{' '}
					<input
						id={inputId}
						type="file"
						multiple
						accept={accept}
						disabled={busy}
						onChange={(event) => {
							const picked = [...(event.currentTarget.files ?? [])]
							event.currentTarget.value = ''
							void add(picked)
						}}
						className="text-[12px] text-text-secondary"
					/>
				</div>
			)}
			{files.length > 0 && (
				<ul className="mt-2 space-y-1">
					{files.map((file) => (
						<li key={file.id} className="flex items-center justify-between gap-2 text-[13px] font-body text-text-primary">
							<span className="truncate" title={file.path}>{file.name} · {formatSize(file.size)}</span>
							<button
								type="button"
								disabled={busy}
								onClick={() => void remove(file)}
								className="text-[12px] text-text-tertiary hover:text-text-secondary"
							>
								Remove
							</button>
						</li>
					))}
				</ul>
			)}
			{error && <p role="alert" className="text-[12px] text-accent-red font-body mt-1">{error}</p>}
			{required && locallyAvailable && files.length === 0 && <p className="text-[11px] text-accent-red font-body mt-1">This field is required.</p>}
		</div>
	)
}
