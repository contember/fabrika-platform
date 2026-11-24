/** `all` is a global grant: the caller may act in every value of the dimension, including ones created later. */
export const readable = (values: readonly string[] | 'all') => values === 'all' ? { all: true, values: [] } : { all: false, values: [...values] }

/** The organizations the application knows: a real application reads its own data; this one keeps a list. */
export const ORGANIZATIONS: readonly { value: string; label: string }[] = [
	{ value: 'acme', label: 'Acme Corporation' },
	{ value: 'globex', label: 'Globex' },
	{ value: 'hooli', label: 'Hooli' },
	{ value: 'initech', label: 'Initech' },
	{ value: 'umbrella', label: 'Umbrella' },
]

/** The organizations a caller may read: every one for a global grant, else those it holds. */
export const organizationValues = (values: readonly string[] | 'all') => ({
	values: ORGANIZATIONS.filter((organization) => values === 'all' || values.includes(organization.value)),
})
