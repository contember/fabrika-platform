// What `bunx fabrika app dev` starts the demo with: the roastery Pražírna Zrnko, five customers, their orders and a
// few invoicing records, and the four people of the demo. Every name, company and number is made up. It writes through
// the endpoints, as the tests do, and answers whom the persona picker offers.

import { createClient } from '@fabrika/app/client'
import type { DevSeed } from '@fabrika/app/testing'
import { contract } from '../fabrika.contract'
import { FIRM_ID } from '../src/schemas'

const seed: DevSeed<typeof contract> = async (dev) => {
	const jana = dev.testCaller([{ role: 'majitel' }], { label: 'Jana Králová', email: 'jana@zrnko.example' })
	const petr = dev.testCaller([{ role: 'obchodnik' }], { label: 'Petr Horák', email: 'petr@zrnko.example' })
	const eva = dev.testCaller([{ role: 'obchodnik' }], { label: 'Eva Benešová', email: 'eva@zrnko.example' })
	const lenka = dev.testCaller([{ role: 'uctarna' }], { label: 'Lenka Dvořáková', email: 'lenka@zrnko.example' })

	const asJana = createClient(contract, 'api', { fetch: dev.browser(jana) })
	const asPetr = createClient(contract, 'api', { fetch: dev.browser(petr) })
	const asEva = createClient(contract, 'api', { fetch: dev.browser(eva) })
	const asLenka = createClient(contract, 'api', { fetch: dev.browser(lenka) })

	const customer = async (name: string, ico: string, city: string, email: string, rep: { readonly id: string; readonly label: string } | null) => {
		const { id } = await asJana.customers.create({ firmId: FIRM_ID, name, ico, city, email })
		if (rep !== null) await asJana.customers.assign({ id, salesperson: rep.id, label: rep.label })
		return id
	}
	const lipa = await customer('Kavárna U Modré lípy', '99000101', 'Praha', 'objednavky@modralipa.example', petr)
	const roh = await customer('Bistro Na Rohu', '99000102', 'Praha', 'kuchyne@narohu.example', petr)
	const podzamci = await customer('Hotel Podzámčí', '99000103', 'Český Krumlov', 'nakup@podzamci.example', eva)
	const venecek = await customer('Cukrárna Věneček', '99000104', 'Brno', 'info@venecek.example', eva)
	const posta = await customer('Restaurace Stará pošta', '99000105', 'Olomouc', 'provoz@starapost.example', null)

	const order1 = await asPetr.orders.create({
		customerId: lipa,
		number: 'OBJ-2026-0412',
		title: 'Espresso směs Zrnko, 12 kg',
		dueOn: '2026-11-14',
		amountCzk: 7440,
	})
	await asPetr.orders.create({ customerId: lipa, number: 'OBJ-2026-0431', title: 'Filtrová Etiopie, 3 kg', dueOn: '2026-11-21', amountCzk: 2310 })
	const order3 = await asPetr.orders.create({
		customerId: roh,
		number: 'OBJ-2026-0418',
		title: 'Espresso směs Zrnko, 6 kg',
		dueOn: '2026-11-13',
		amountCzk: 3720,
	})
	const order4 = await asEva.orders.create({
		customerId: podzamci,
		number: 'OBJ-2026-0399',
		title: 'Snídaňová směs, 20 kg',
		dueOn: '2026-11-08',
		amountCzk: 11800,
	})
	await asEva.orders.create({ customerId: venecek, number: 'OBJ-2026-0427', title: 'Dekaf Kolumbie, 2 kg', dueOn: '2026-11-19', amountCzk: 1580 })
	await asEva.orders.create({
		customerId: podzamci,
		number: 'OBJ-2026-0433',
		title: 'Kávovar k zapůjčení, servis',
		dueOn: '2026-11-28',
		amountCzk: 4500,
	})
	await asJana.orders.create({ customerId: posta, number: 'OBJ-2026-0405', title: 'Espresso směs Zrnko, 8 kg', dueOn: '2026-11-12', amountCzk: 4960 })

	await asPetr.orders.setStatus({ id: order1.id, expectVersion: order1.version, status: 'potvrzena' })
	await asPetr.orders.setStatus({ id: order3.id, expectVersion: order3.version, status: 'expedovana' })
	const delivered = await asEva.orders.setStatus({ id: order4.id, expectVersion: order4.version, status: 'expedovana' })
	await asEva.orders.setStatus({ id: order4.id, expectVersion: delivered.version, status: 'dorucena' })

	const billed = await asLenka.billing.prepare({ orderId: order4.id, vatRate: 12 })
	await asLenka.billing.markInvoiced({ orderId: order4.id, id: billed.id, expectVersion: 1, invoiceNumber: 'FV-2026-0187' })
	await asLenka.billing.prepare({ orderId: order3.id, vatRate: 12 })

	return {
		personas: [
			{ name: 'Jana', description: 'Majitelka: vidí a smí všechno, i mazat objednávky', caller: jana },
			{ name: 'Petr', description: 'Obchodník: jen své odběratele (Modrá lípa, Na Rohu)', caller: petr },
			{ name: 'Eva', description: 'Obchodnice: jen své odběratele (Podzámčí, Věneček)', caller: eva },
			{ name: 'Lenka', description: 'Účtárna: objednávky čte, fakturuje, mazat nesmí', caller: lenka },
		],
		scopes: { firm: [{ value: FIRM_ID, label: 'Pražírna Zrnko' }] },
	}
}

export default seed
