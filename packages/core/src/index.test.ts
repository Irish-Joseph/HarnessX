import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { BudgetGuard, chooseModel, estimateUsd } from './index';
const local = {id:'local', inputCostPerMillion:0, outputCostPerMillion:0, available:true};
const paid = {id:'paid', inputCostPerMillion:1, outputCostPerMillion:2, available:true};
test('cost estimate uses both token directions', () => {
  assert.equal(estimateUsd(paid, {inputTokens:1_000_000,outputTokens:500_000}),2);
});
test('zero budget chooses local model', () => {
  assert.equal(chooseModel([paid,local], {inputTokens:1000,outputTokens:1000},0)?.id,'local');
});
test('unavailable models are excluded', () => {
  assert.equal(chooseModel([{...local,available:false}],{inputTokens:1,outputTokens:1},0),undefined);
});
test('budget guard prevents overspending', () => {
  const guard = new BudgetGuard(1);
  guard.reserve(.4);
  assert.equal(guard.remainingUsd,.6);
  assert.throws(()=>guard.reserve(.7),/Budget exceeded/);
});
test('invalid usage rejected', () => {
  assert.throws(()=>estimateUsd(local,{inputTokens:-1,outputTokens:0}),/Invalid/);
});
