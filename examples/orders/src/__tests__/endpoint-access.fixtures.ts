// What the generated endpoint access tests need beyond the schemas: an IČO the scaffold cannot sample, and the child
// rows that an unassignment and an invoice mark name.
export const fixtures = {
	'api.customers.create': { firmId: 'zrnko', name: 'Kavárna Vzor', ico: '99000099', city: 'Praha', email: 'vzor@example.test' },
}
export const rows = { 'api.customers.unassign': { assignment: 'customer_reps' }, 'api.billing.markInvoiced': { id: 'billing' } }
