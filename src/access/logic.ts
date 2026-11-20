/** `all` is a global grant: the caller may act in every value of the dimension, including ones created later. */
export const readable = (values: readonly string[] | 'all') => values === 'all' ? { all: true, values: [] } : { all: false, values: [...values] }
