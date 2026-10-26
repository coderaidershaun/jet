// Free replies imitate prompt growth without starting a provider.

import { MOODS as MOOD_WORDS } from '../jet/director.js';
const SPOKEN_MOODS = MOOD_WORDS.filter((word) => word !== 'neutral');

/** Tokens already in the prompt before the user says anything: Claude Code's own prompt, tools and Jet's notes. */
export const BASE_CONTEXT_TOKENS = 36000;

const REPLIES = [
  'Happy to help with that. Tell me a little more about what you have in mind and I will think it through with you.',
  'That sounds doable. Here is how I would start:\n\n- Write down the one thing that has to happen first\n- Leave the rest until that is done\n- Come back to me if you get stuck\n\nWant me to turn that into a plan?',
  'Good question. I would look at **what you already have** before adding anything new. Most of the time the answer is a small change to something that exists.',
  'Short answer: yes. The longer answer depends on how much time you have, and I am glad to walk through the trade-offs if that helps.',
];

const CODE_REPLY = 'Here is a small example you can start from:\n\n```js\nfunction greet(name) {\n  return `Hello, ${name}!`;\n}\n\nconsole.log(greet("Jet"));\n```\n\nPaste it in and tell me what you see.';

const MATH_REPLY = [
  String.raw`Here is the Black-Scholes price of a European call. The stock follows a lognormal walk with volatility \( \sigma \), and \( N(\cdot) \) is the standard normal distribution function:`,
  '',
  String.raw`\[`,
  String.raw`C = S\,N(d_1) - K e^{-rT} N(d_2)`,
  String.raw`\]`,
  '',
  'where',
  '',
  '$$',
  String.raw`d_1 = \frac{\ln(S/K) + \left(r + \tfrac{1}{2}\sigma^2\right)T}{\sigma\sqrt{T}}, \qquad d_2 = d_1 - \sigma\sqrt{T}`,
  '$$',
  '',
  String.raw`For a $100 stock, a $100 strike, one year to expiry, a 5% rate and \( \sigma = 0.2 \):`,
  '',
  '| Input | Value |',
  '| --- | --- |',
  String.raw`| Spot \( S \) | 100 |`,
  String.raw`| Strike \( K \) | 100 |`,
  String.raw`| Rate \( r \) | 5% |`,
  String.raw`| Volatility \( \sigma \) | 0.20 |`,
  String.raw`| Call price \( C \) | 10.45 |`,
  '',
  'The call is',
  '',
  String.raw`\[`,
  String.raw`\text{moneyness} = \begin{cases} \text{in the money} & S > K \\ \text{at the money} & S = K \\ \text{out of the money} & S < K \end{cases}`,
  String.raw`\]`,
  '',
  String.raw`and a book of calls with weights \( \vec{w} \) is worth \( \vec{w} \cdot \vec{C} \).`,
  '',
  '```python',
  'from math import exp, log, sqrt',
  'from statistics import NormalDist',
  '',
  'def call(S, K, T, r, sigma):',
  '    d1 = (log(S / K) + (r + sigma**2 / 2) * T) / (sigma * sqrt(T))',
  '    d2 = d1 - sigma * sqrt(T)',
  '    N = NormalDist().cdf',
  '    return S * N(d1) - K * exp(-r * T) * N(d2)',
  '```',
].join('\n');

/** @param {string} text @param {string} word */
const mentions = (text, word) => new RegExp('\\b' + word, 'i').test(text);

/** @param {string} text   what the user wrote */
export function wants(text) {
  return {
    code: mentions(text, 'code'),
    math: mentions(text, 'math'),
    slow: mentions(text, 'slow'),
    error: mentions(text, 'error'),
    missing: mentions(text, 'missing'),
    timeout: mentions(text, 'timeout'),
    fresh: mentions(text, 'fresh'),
    quanty: mentions(text, 'quanty'),
    quantyDown: mentions(text, 'quanty down'),
  };
}

/**
 * The mood word the user asked for, else one on every third reply, else none.
 * @param {string} text
 * @param {number} replyNumber   1 for the first reply
 * @returns {string | null}
 */
export function moodFor(text, replyNumber) {
  const asked = MOOD_WORDS.find((word) => mentions(text, word));
  if (asked) return asked;
  if (replyNumber % 3 !== 0) return null;
  return SPOKEN_MOODS[(replyNumber / 3 - 1) % SPOKEN_MOODS.length];
}

/** @param {string} text @param {number} replyNumber */
export function bodyFor(text, replyNumber) {
  if (wants(text).math) return MATH_REPLY;
  if (wants(text).code) return CODE_REPLY;
  return REPLIES[(replyNumber - 1) % REPLIES.length];
}

/** @param {string} text @param {number} size */
export function chunksOf(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

export const tokensIn = (text) => Math.max(1, Math.ceil(text.length / 4));

/**
 * Token counts for one turn. A warm cache is read and only the new part is
 * written; a cold or new one writes everything again.
 * @param {{ contextBefore: number, userText: string, replyText: string, warm: boolean }} turn
 */
export function usageFor({ contextBefore, userText, replyText, warm }) {
  const outputTokens = tokensIn(replyText);
  const added = tokensIn(userText) + outputTokens;
  const contextAfter = contextBefore + added;
  const cacheReadTokens = warm ? contextBefore : 0;
  const cacheCreationTokens = warm ? added : contextAfter;
  return {
    contextAfter,
    outputTokens,
    usage: { inputTokens: 12, cacheReadTokens, cacheCreationTokens, cacheCreation1hTokens: cacheCreationTokens },
  };
}

/** @param {{ inputTokens: number, cacheReadTokens: number, cacheCreation1hTokens: number }} usage @param {number} outputTokens */
export function costFor(usage, outputTokens) {
  const dollars = usage.inputTokens * 3e-6 + usage.cacheReadTokens * 0.3e-6 + usage.cacheCreation1hTokens * 6e-6 + outputTokens * 15e-6;
  return Math.round(dollars * 10000) / 10000;
}

export const MESSAGES = {
  fresh: "Started a fresh conversation so your changes apply. Jet's memory is kept.",
  claudeFailed: 'Invalid API key · Please run /login',
  claudeMissing: 'Claude Code was not found; looked in ~/.local/bin/claude, /opt/homebrew/bin/claude, /usr/local/bin/claude',
  timeout: 'Claude stopped responding after 2 minutes.',
  busy: 'Jet is still replying; wait for the reply or press Stop.',
};

export const MODEL_IDS = { fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };
