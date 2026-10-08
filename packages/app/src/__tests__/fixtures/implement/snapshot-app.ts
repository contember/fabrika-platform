// The fixture application behind a dependency that snapshots the environment at module load.

import { notesApp } from './app'
import { snapshot } from './environment-snapshot'

export const snapshotKeys = Object.keys(snapshot)

export default notesApp(new Map())
