import { type TestCallerOptions, testKit } from '@fabrika/app/testing'
import { notesApp } from '../fixtures/implement/app'

const kit = testKit(notesApp(new Map()))
const options: TestCallerOptions = {}

export const person: string = kit.testCaller([]).label
export const script: string = kit.testCaller([], { kind: 'machine' }).label
export const connector: string = kit.testCaller([], { kind: 'app', app: 'crm@test' }).label
export const either: string | null = kit.testCaller([], options).label

// mistake: a link holder's key carries no label
export const holder: string = kit.testCaller([], { kind: 'link' }).label
