// The model choices the page offers, and which provider each one belongs to.
export const MODELS = [
  ['gpt-6.1-sol', 'GPT-6.1 Sol'], ['gpt-6-astra', 'GPT-6 Astra'],
  ['gpt-6-sol', 'GPT-6 Sol'], ['gpt-6-luna', 'GPT-6 Luna'], ['gpt-5.6-sol', 'GPT-5.6 Sol'],
  ['gpt-5.6-terra', 'GPT-5.6 Terra'], ['gpt-5.6-luna', 'GPT-5.6 Luna'], ['gpt-reserve', 'GPT Reserve'],
  ['gemini-4-neon', 'Gemini 4 Neon'], ['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'],
];
const isCodex = (model) => model.startsWith('gpt-');
const isAgy = (model) => model === 'gemini-4-neon';
export const providerOf = (model) => (isCodex(model) ? 'Codex' : isAgy(model) ? 'agy' : 'Claude');
export function effortsFor(model) {
  if (isAgy(model)) return ['low', 'medium', 'high', 'xhigh'];
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
  if (isCodex(model) && !model.includes('luna') && model !== 'gpt-reserve') levels.push('ultra');
  return levels;
}
