export const MODELS = [
  ['gpt-6.1-sol', 'GPT-6.1 Sol'], ['gpt-6-astra', 'GPT-6 Astra'],
  ['gpt-6-sol', 'GPT-6 Sol'], ['gpt-6-luna', 'GPT-6 Luna'], ['gpt-5.6-sol', 'GPT-5.6 Sol'],
  ['gpt-5.6-terra', 'GPT-5.6 Terra'], ['gpt-5.6-luna', 'GPT-5.6 Luna'], ['gpt-reserve', 'GPT Reserve'],
  ['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'],
];
export const isCodex = (model) => model.startsWith('gpt-');
export function effortsFor(model) {
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
  if (isCodex(model) && !model.includes('luna') && model !== 'gpt-reserve') levels.push('ultra');
  return levels;
}
