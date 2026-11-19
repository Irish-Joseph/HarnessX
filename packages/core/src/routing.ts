import { Message, Model, Usage } from './types';

export function estimateTokens(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + Math.ceil(message.content.length / 4) + 8, 0);
}
export function estimateCost(model: Model, usage: Usage): number {
  if (![usage.inputTokens, usage.outputTokens].every(n => Number.isFinite(n) && n >= 0)) throw new Error('Invalid token usage');
  return (usage.inputTokens * model.inputCostPerMillion + usage.outputTokens * model.outputCostPerMillion) / 1_000_000;
}
export function taskComplexity(prompt: string): number {
  const words = prompt.toLowerCase();
  const signals = [/refactor|architect|debug|implement|multi.step|across files/, /test|security|migration|performance/, /plan|agent|fix|error/];
  return Math.min(5, 1 + signals.reduce((n, pattern) => n + Number(pattern.test(words)), 0) + Number(prompt.length > 1200));
}
export function routeModels(models: Model[], messages: Message[], maxUsd: number, preferredId?: string, complexityOverride?: number): Model[] {
  if (!Number.isFinite(maxUsd) || maxUsd < 0) throw new Error('Invalid budget');
  if (!messages.length) return [];
  const complexity = complexityOverride ?? taskComplexity(messages.at(-1)?.content ?? '');
  const effectiveTokens = (model: Model): number => {
    const budget = model.contextTokens - model.maxOutputTokens;
    if (budget < 128 || estimateTokens([messages.at(-1)!]) > budget) return Infinity;
    try { return estimateTokens(compactMessages(messages, budget)); } catch { return Infinity; }
  };
  const eligible = models.filter(m => m.available && Number.isFinite(effectiveTokens(m)) &&
    estimateCost(m, { inputTokens: effectiveTokens(m), outputTokens: m.maxOutputTokens }) <= maxUsd);
  return eligible.sort((a, b) => {
    const score = (m: Model) => (m.id === preferredId || `${m.provider}/${m.id}` === preferredId ? 100 : 0) +
      Math.min(m.capability, complexity) * 10 + m.speed * (complexity < 3 ? 3 : 1) -
      estimateCost(m, { inputTokens: effectiveTokens(m), outputTokens: m.maxOutputTokens }) * 100;
    return score(b) - score(a) || a.id.localeCompare(b.id);
  });
}
export function compactMessages(messages: Message[], maxTokens: number): Message[] {
  if (maxTokens < 128) throw new Error('Context window too small');
  const system = messages.filter(m => m.role === 'system').slice(0, 1);
  const others = messages.filter(m => m.role !== 'system');
  const selected: Message[] = [];
  let used = estimateTokens(system);
  if (used > maxTokens) throw new Error('System instructions exceed context window');
  for (let i = others.length - 1; i >= 0; i--) {
    const cost = estimateTokens([others[i]]);
    if (used + cost > maxTokens) break;
    selected.unshift(others[i]); used += cost;
  }
  if (selected.length < others.length) {
    const note: Message = { role: 'system', content: `${others.length - selected.length} earlier messages omitted. Use session memory.` };
    if (used + estimateTokens([note]) <= maxTokens) selected.unshift(note);
  }
  return [...system, ...selected];
}
