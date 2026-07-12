# Cost-Aware Model Routing Reference

## Decision matrix

| Work | Start | Escalate when |
|---|---|---|
| Git/container/workspace/background-task status | Luna | state is contradictory or a mutation needs approval |
| Inventory, grep, file map, evidence index | Luna | ownership or architectural meaning is unclear |
| Run selected tests/builds and summarize results | Luna | failures are ambiguous or suggest a design defect |
| Mechanical docs/status/issue formatting | Luna | text changes policy, authority, or a parsed contract |
| Bounded web fact collection | Luna | sources conflict or synthesis affects a material decision |
| Ordinary codebase reconnaissance | Luna or Terra | cross-cutting data flow or hidden contracts appear |
| Scoped implementation with clear acceptance | Terra | a new product/architecture/security decision is required |
| Routine diagnosis with a reproduction | Terra | hypotheses remain ambiguous after instrumentation |
| Plan, context handoff, normal code review | Terra | scope is cross-cutting, disputed, or high-risk |
| Architecture and cross-repo ownership | Sol | — |
| Credentials, authorization, privacy, destructive behavior | Sol | — |
| Migration/recovery/concurrency/public interface | Sol | — |
| Production/release authority | Sol plus operator approval | never infer approval from model confidence |
| Final high-risk Audit or reviewer disagreement | Sol | — |

## Routing rules

1. **Risk beats role.** `reviewer` does not always mean Sol and `scout` does not always mean Luna.
2. **Verification lowers the required tier.** A narrow edit with strong tests can start on Terra; an ambiguous one-line authority change belongs on Sol.
3. **Escalate decisions, not chores.** A Sol parent may ask Luna to gather status and Terra to implement, then inspect only the decision-bearing delta.
4. **Do not downgrade silently.** If a requested/required model is unavailable, report the fallback and its implications.
5. **Do not retry blindly on a stronger model.** First identify whether the failure was capability, missing context, bad tooling, or a faulty task contract.
6. **Fresh context is the default economy boundary.** Fork only for decision continuity that cannot be summarized safely.

## GPT-5.6 runtime evidence

OpenAI's public Codex documentation did not document the Sol/Terra/Luna aliases when this policy was created. Treat them as account/runtime-specific IDs and verify them through the active model catalog:

```bash
pi --list-models openai-codex
```

Usage metadata observed on 2026-07-12 reported:

| Model | Input / 1M | Output / 1M | Cached input / 1M | Relative to Luna |
|---|---:|---:|---:|---:|
| `gpt-5.6-sol` | $5.00 | $30.00 | $0.50 | 5× |
| `gpt-5.6-terra` | $2.50 | $15.00 | $0.25 | 2.5× |
| `gpt-5.6-luna` | $1.00 | $6.00 | $0.10 | 1× |

These are an observed snapshot, not a permanent price contract. Recompute from current `usage.cost` records with the bundled audit script before making budget forecasts.

## Subagent examples

### Luna fact collector

```ts
subagent({
  agent: "scout",
  model: "openai-codex/gpt-5.6-luna",
  context: "fresh",
  task: "Inventory the named paths and return a bounded file map. Do not interpret architecture. Stop if ownership is ambiguous.",
  output: "inventory.md",
  outputMode: "file-only",
  toolBudget: { soft: 10, hard: 16, block: ["read", "grep", "find", "ls"] },
  async: true
})
```

### Terra implementation

```ts
subagent({
  agent: "worker",
  model: "openai-codex/gpt-5.6-terra",
  context: "fresh",
  task: "Implement the approved bounded change and run focused tests. Stop and ask if a new public contract, security decision, or scope choice is required.",
  async: true
})
```

### Sol adjudication

```ts
subagent({
  agent: "oracle",
  model: "openai-codex/gpt-5.6-sol",
  context: "fork",
  task: "Adjudicate the named authority/security decision against inherited constraints. Review only; do not perform mechanical implementation.",
  async: true
})
```

## Context economics

Cached context is charged on each model turn. At the observed rates, a fully cached 372K context costs approximately $0.186 on Sol, $0.093 on Terra, and $0.037 on Luna before new input/output. Therefore:

- move routine follow-ups into fresh, bounded children;
- give children paths and acceptance criteria instead of the entire transcript;
- avoid repeated `status`/`read`/`bash` turns in a huge parent context;
- use `wait()` rather than model-driven polling;
- save large child output to files and read only the needed sections;
- compact or close a workstream at a safe decision seam.

## Audit methodology

The audit script:

- recursively scans Pi JSONL sessions;
- counts only assistant usage records in the selected time window;
- deduplicates copied/forked history using `responseId`, then message id;
- reports model/day/action-class cost and tokens;
- derives effective component prices from `usage.cost` metadata;
- never reads user prompt text or encrypted reasoning content.

Do not sum every JSONL record without deduplication: forked or resumed sessions can contain copied response history and inflate totals.
