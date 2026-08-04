/** Normalize an email identity for case-insensitive exact-mailbox comparisons. */
export function normalizeEmailIdentity(value: string): string {
	return value.normalize('NFC').trim().toLocaleLowerCase('en-US')
}
