// The authorization vocabulary of the orders demo: a small roastery takes orders from its customers. A customer lies in
// the firm, an order in a customer, and each order carries its invoicing records. The owner grants every role
// app-wide; a salesperson reaches only the customers an assignment names them at (`handling`), and accounting reads
// the orders and keeps the invoicing records, but never deletes an order.

import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'orders',
	displayName: 'Objednávky od odběratelů',
	locale: 'cs',
	dimensions: {
		firm: {},
		customer: { in: 'firm' },
		order: { in: 'customer' },
	},
	actions: {
		'customers.read': 'Číst odběratele a jejich kontakty',
		'customers.write': 'Zakládat a upravovat odběratele',
		'customers.assign': 'Přidělovat odběratele obchodníkům',
		'orders.read': 'Číst objednávky',
		'orders.write': 'Zakládat objednávky a měnit jejich stav',
		'orders.delete': 'Mazat objednávky',
		'billing.read': 'Číst podklady k fakturaci',
		'billing.write': 'Připravovat podklady k fakturaci a označit je jako vyfakturované',
	},
	relations: {
		handling: { dimension: 'customer' },
	},
	roles: {
		majitel: {
			grants: [
				'customers.read',
				'customers.write',
				'customers.assign',
				'orders.read',
				'orders.write',
				'orders.delete',
				'billing.read',
				'billing.write',
			],
		},
		obchodnik: {
			grants: [],
			via: { handling: ['customers.read', 'orders.read', 'orders.write'] },
		},
		uctarna: {
			grants: ['orders.read', 'billing.read', 'billing.write'],
		},
	},
})
