---
name: cost-aware-model-routing
description: Routes Pi parent, subagent, chain, review, research, and lane work to the cheapest model that can preserve correctness, with explicit escalation and context-cost controls. Use whenever selecting Sol, Terra, or Luna; launching subagents or agent-driven builds; reviewing model spend; or deciding whether stronger reasoning is justified.
---

# Cost-Aware Model Routing

Optimize **cost subject to outcome quality**. Route each task, not the whole workstream, to the cheapest capable tier.

## Route before launch

1. Identify the task's judgment, ambiguity, blast radius, and verification signal.
2. Pick the starting tier:
   - **Luna** — deterministic collection/execution: status, inventory, bounded search, formatting, test runs, evidence, bookkeeping.
   - **Terra** — ordinary engineering judgment: scoped implementation, diagnosis with a reproduction, research synthesis, planning, and checklist review.
   - **Sol** — consequential ambiguity: architecture, authority/security/privacy, destructive or production decisions, cross-repo contracts, conflicting evidence, and final high-risk adjudication.
3. Pass the model explicitly when launching a child. Do not accidentally inherit an expensive parent model.
4. State the escalation trigger in the task contract. A cheaper worker must stop rather than guess across a higher-tier boundary.
5. Keep final authority in the parent. Use Sol to decide only when the risk warrants it, not to perform every mechanical step.

## Preserve quality with a verification ladder

- Let Luna gather facts or execute a deterministic checklist.
- Let Terra implement or synthesize bounded work from those facts.
- Use Sol only for a named high-risk decision, disagreement, or final review surface.
- A lower-tier result is evidence, not automatically truth. Independently validate material claims.
- Escalate immediately for credentials, authorization, privacy, destructive behavior, migrations, production, or unclear source-of-truth ownership.

## Control context cost

- Prefer `context: "fresh"` plus a small task packet for Luna/Terra work.
- Use forked context only when inherited decisions are essential.
- Cap reads, tools, turns, fanout, and output. Use `outputMode: "file-only"` for large artifacts.
- Do not poll with model turns. Use lifecycle tools, event notifications, or `wait()`.
- End or compact long sessions at safe seams; do not spend a 200K–372K context on routine status checks.
- Prefer deterministic scripts over regenerating inventory, formatting, or accounting logic.

## Defaults for GPT-5.6 tiers

```text
scout/status/evidence/test runner     Luna
researcher/context-builder/planner    Terra
worker/routine reviewer               Terra
oracle/security/final high-risk audit Sol
```

Treat these as starting points, not role entitlements. A security-focused reviewer is Sol; a mechanical duplicate scan is Luna.

## Audit actual usage

Run the bundled privacy-safe, response-deduplicated audit:

```bash
node /Users/john/projects/pi-subagents/skills/cost-aware-model-routing/scripts/audit-session-costs.mjs --days 7 --format markdown
```

For another installation, resolve `scripts/audit-session-costs.mjs` relative to this skill directory. It reads usage metadata and tool names, not prompt or reasoning content. Review [REFERENCE.md](REFERENCE.md) for the full matrix, escalation rules, measured-price method, and launch examples.
