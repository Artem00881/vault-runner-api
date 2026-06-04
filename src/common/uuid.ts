/** Canonical UUID (v4-shape, case-insensitive) regex + predicate. Shared so the
 *  reporting key parser and the reporting cursor validator don't each carry a copy. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (s: string): boolean => UUID_RE.test(s);
