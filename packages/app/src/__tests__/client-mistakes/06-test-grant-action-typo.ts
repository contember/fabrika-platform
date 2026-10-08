import { testKit } from '@fabrika/app/testing'
import { notesApp } from '../fixtures/implement/app'

const kit = testKit(notesApp(new Map()))

// mistake: a grant names an action the contract does not declare
export const reader = kit.testCaller([{ action: 'notes.raed' }])
