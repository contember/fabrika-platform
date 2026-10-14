// What `bunx fabrika app dev` starts Notes with: two workspaces, the people who work in them, and an invitation a staff
// member sent a guest. It writes through the endpoints, as the application's tests do, and answers whom the picker offers.

import { createClient } from '@fabrika/app/client'
import type { DevSeed } from '@fabrika/app/testing'
import { contract } from '../fabrika.contract'

const seed: DevSeed<typeof contract> = async (dev) => {
	const design = dev.scope('workspace', 'design')
	const sales = dev.scope('workspace', 'sales')
	const petra = dev.testCaller([{ role: 'staff' }, { role: 'editor', scope: design }, { role: 'editor', scope: sales }], {
		label: 'Petra Nováková',
		email: 'petra@notes.example',
	})
	const tomas = dev.testCaller([{ role: 'author', scope: design }], { label: 'Tomáš Dvořák', email: 'tomas@notes.example' })
	const gita = dev.testCaller([{ role: 'guest', scope: design }], { label: 'Gita Rao', email: 'gita@partner.example', affiliation: 'external' })

	const asTomas = createClient(contract, 'api', { fetch: dev.browser(tomas) })
	for (const title of ['Brand refresh brief', 'Interview notes, week 41', 'Logo options']) {
		await asTomas.notes.create({ workspaceId: design.value, title })
	}
	await createClient(contract, 'api', { fetch: dev.browser(petra) }).notes.create({ workspaceId: sales.value, title: 'Q4 pipeline' })
	await createClient(contract, 'people', { fetch: dev.browser(petra) }).guests.invite({
		workspaceId: design.value,
		email: 'marta@studio.example',
		message: 'Join us for the brand review.',
	})

	return {
		personas: [
			{ name: 'Petra', description: 'Staff: edits both workspaces and invites guests', caller: petra },
			{ name: 'Tomáš', description: 'Writes the design notes', caller: tomas },
			{ name: 'Gita', description: 'A guest from a partner studio, reads the design notes', caller: gita },
		],
		scopes: { workspace: [{ value: design.value, label: 'Design' }, { value: sales.value, label: 'Sales' }] },
	}
}

export default seed
