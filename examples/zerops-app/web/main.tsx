// The SPA: the notes the signed-in person may read, through the typed client of the `/api` mount and its React hooks,
// with its errors reported to Operations. It imports the contract and the shared schemas only; the SPA build loads the
// contract without its handlers.

import '@fabrika/ui/styles.css'
import { createClient } from '@fabrika/app/client'
import { FabrikaProvider, useQuery } from '@fabrika/app/react'
import { ErrorState, LoadingState, PageHeader } from '@fabrika/ui'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { contract } from '../fabrika.contract'
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_NOTE } from '../src/schemas'
import { startErrorReporting } from './operations'

const api = createClient(contract, 'api', { bounceOnAuth: true })

function Notes() {
	const notes = useQuery(api.notes.list)
	return (
		<main className="fui-app notes">
			<PageHeader title="Notes" />
			{notes.status === 'error'
				? <ErrorState text={notes.error.message} onRetry={() => void notes.refetch()} />
				: notes.status === 'success'
				? (
					<ul id="notes">
						{notes.data.items.map((note) => <li key={note.id}>{note.trashed ? `${note.title} (in the trash)` : note.title}</li>)}
					</ul>
				)
				: <LoadingState />}
			<p id="limits">Up to {MAX_ATTACHMENTS_PER_NOTE} attachments of at most {MAX_ATTACHMENT_BYTES / 1048576} MiB per note.</p>
		</main>
	)
}

await startErrorReporting()
const root = document.getElementById('root')
if (root !== null) {
	createRoot(root).render(
		<StrictMode>
			<FabrikaProvider clients={[api]}>
				<Notes />
			</FabrikaProvider>
		</StrictMode>,
	)
}
