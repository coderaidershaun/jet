// What the library, its rows and the file dialog say about a file, in plain words.
// Pure, with no DOM, so every wording is tested.

import { KINDS, extensionOf, sizeOf } from '../files.js';
import { relativeWords } from '../../plan/model.js';

const NEAR_FULL = 0.9;

export const kindLabel = (kind) => KINDS[kind]?.label ?? 'File';

/** Time words for a Unix millisecond, against `now` in milliseconds: 'just now', '2 h ago'. */
export const whenWords = (ms, now) => relativeWords((ms - now) / 1000);

/** 'Kite budget', or 'Kite budget and 3 more' for a file several chats hold. The keeper chat comes first. */
export function chatsWords(chatIds, titleOf) {
  if (chatIds.length === 0) return '';
  const first = titleOf(chatIds[0]);
  return chatIds.length === 1 ? first : `${first} and ${chatIds.length - 1} more`;
}

/** 'HTML page · 1 KB · 2 h ago · Kite budget', the second line of a file row. */
export function factsWords(file, now, titleOf) {
  return [kindLabel(file.kind), sizeOf(file.bytes), whenWords(file.changedAt, now), chatsWords(file.chats, titleOf)].filter(Boolean).join(' · ');
}

/** Whether a file answers a search: any part of its name, note, kind or the titles of its chats, in any case. */
export function matches(file, query, titleOf) {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  const haystack = [file.name, file.context, kindLabel(file.kind), ...file.chats.map(titleOf)].join('\n').toLowerCase();
  return haystack.includes(needle);
}

/** The usage line and its tone: quiet, then 'warn' from 90 %, then 'bad' when nothing more fits. */
export function usageWords(used, limit) {
  const words = `${sizeOf(used)} of ${sizeOf(limit)} used`;
  if (limit <= 0 || used < limit * NEAR_FULL) return { words, tone: 'quiet' };
  if (used >= limit) return { words: 'No room left for files. Delete files to make room.', tone: 'bad' };
  return { words: `${words}. Delete files you no longer need to make room.`, tone: 'warn' };
}

/** What an armed Delete asks, naming what it takes away. */
export const deleteAsk = (chatCount) => (chatCount > 1 ? `Delete from ${chatCount} chats?` : 'Delete for good?');
export const bulkDeleteAsk = (count) => `Delete ${count} for good?`;

/** A name split where its kind starts, so a rename changes only the part before it. */
export function splitName(name) {
  const extension = extensionOf(name);
  return extension === '' ? { stem: name, extension: '' } : { stem: name.slice(0, -extension.length - 1), extension };
}

/** The file name a download answer gives, or `fallback`. */
export function attachmentName(disposition, fallback) {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? '');
  if (encoded) {
    try { return decodeURIComponent(encoded[1]); } catch (error) { console.warn('the encoded file name could not be read, so the plain one is used:', error); }
  }
  return /filename="([^"]+)"/i.exec(disposition ?? '')?.[1] ?? fallback;
}
