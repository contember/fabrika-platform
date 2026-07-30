import { BuzolaProvider } from '@buzola/router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { pageRegistry, routes } from './buzola.gen'
// IBM Plex — drawn for a machine company, which is why the console uses it. Sans is the variable
// weight axis (100–700); Mono ships static weights and carries every id, ref, sha and log line.
import '@fontsource-variable/ibm-plex-sans/wght.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fabrika/iam-ui/styles.css'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

createRoot(root).render(
	<StrictMode>
		<BuzolaProvider routes={routes} pageRegistry={pageRegistry} />
	</StrictMode>,
)
