import { testKit } from '@fabrika/app/testing'
import { notesApp } from '../fixtures/implement/app'

const kit = testKit(notesApp(new Map()))
const workspace = kit.scope('workspace', 'w1')

export const editor = kit.testCaller([{ role: 'editor', scope: workspace }])

// mistake: a scope names a dimension the contract does not declare
export const stranger = kit.scope('workspaces', 'w1')
