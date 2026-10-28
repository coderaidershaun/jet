// Checks for values that come from outside. A result is data, so a field of the wrong kind reads as
// empty and never throws.

export const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
export const recordOf = (value) => (isRecord(value) ? value : {});
export const listOf = (value) => (Array.isArray(value) ? value : []);
export const stringOf = (value) => (typeof value === 'string' ? value : '');
export const stringsOf = (value) => listOf(value).filter((item) => typeof item === 'string');
export const orNull = (value) => (typeof value === 'string' && value !== '' ? value : null);
export const joined = (...parts) => parts.filter(Boolean).join(' · ');
export const count = (n, noun) => n + ' ' + noun + (n === 1 ? '' : 's');
/** A finite number, else null. */
export const numberOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
