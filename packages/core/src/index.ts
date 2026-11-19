export interface Model {
  id: string;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  available: boolean;
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}
export function estimateUsd(model: Model, usage: Usage): number {
  if (![model.inputCostPerMillion, model.outputCostPerMillion, usage.inputTokens, usage.outputTokens].every(Number.isFinite) ||
      model.inputCostPerMillion < 0 || model.outputCostPerMillion < 0 ||
      usage.inputTokens < 0 || usage.outputTokens < 0) {
    throw new Error("Invalid pricing or token count");
  }
  return (usage.inputTokens * model.inputCostPerMillion +
    usage.outputTokens * model.outputCostPerMillion) / 1_000_000;
}
export function chooseModel(models: Model[], usage: Usage, maxUsd: number): Model | undefined {
  if (!Number.isFinite(maxUsd) || maxUsd < 0) throw new Error("Invalid budget");
  return models.filter(m => m.available && estimateUsd(m, usage) <= maxUsd)
    .sort((a,b) => estimateUsd(a, usage) - estimateUsd(b, usage) || a.id.localeCompare(b.id))[0];
}
export class BudgetGuard {
  private spent = 0;
  constructor(readonly limitUsd: number) {
    if (!Number.isFinite(limitUsd) || limitUsd < 0) throw new Error("Invalid budget");
  }
  get remainingUsd(): number { return Math.max(0, this.limitUsd - this.spent); }
  reserve(amountUsd: number): void {
    if (!Number.isFinite(amountUsd) || amountUsd < 0) throw new Error("Invalid amount");
    if (amountUsd > this.remainingUsd + 1e-12) throw new Error("Budget exceeded");
    this.spent += amountUsd;
  }
}
