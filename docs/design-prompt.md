# Grouping prompt design

Why the model used to group everything on one domain into one group, and how the prompt is
structured now.

## Two segments

The prompt has exactly two segments with separate owners:

1. **Fixed system prompt** (`SYSTEM_PROMPT` in `lib/prompt.ts`) — the role statement ("you
   organize browser tabs") plus the output contract (JSON only, schema, id rules, no
   catch-all groups). It carries **zero** grouping policy, so it can never bias the model
   toward domain grouping again.
2. **User policy** (`Config.prompt`) — the whole "how to group" strategy. Shipped as
   **prefills** (`BUILT_IN_PREFILLS` in `lib/constants.ts`), freely editable in the options
   page. An empty policy is a blocking state (see below), so the policy is always explicit.

Message layout sent to the model:

```
[system] role + output contract
[user]   policy text (omitted when blank — cannot happen at runtime, see gate below)
[user]   JSON array of candidate tabs
```

The invalid-plan retry (`buildRetryMessages`) appends to these base messages, so the policy
survives the retry round trip untouched.

## Structured outputs

`requestPlan` sends `response_format: { type: "json_schema", json_schema: GROUPING_SCHEMA,
strict: true }` plus `provider.require_parameters: true`, so routing only picks endpoints that
honor the schema (support is per endpoint, not per model; a rejecting endpoint fails loudly,
never silently ignores). `llm.ts` walks a fallback ladder — reasoning param → schema → plain —
remembering each endpoint quirk for the session (`resetReasoningParamSupport` /
`resetStructuredOutputSupport` are the test hooks). `parse-groups.ts` validation and the
single invalid-plan retry remain the final backstop; the fixed contract text doubles as the
instruction set on the plain fallback. `verifyApiKey` sends no schema (its payload is a 1-token
ping).

## Prefills

- `BUILT_IN_PREFILLS: { id, label, text }[]` — one entry per shipped policy; adding one is a
  single array entry plus nothing else.
- `Config.prefillId` is **provenance only**, derived at save time from verbatim text match.
  Editing one character drops it, so a future prefill update can be targeted at users whose
  text still matches — and never stomps customizations.
- Options page: dropdown (Custom + built-ins), textarea, Save, "Restore selected prefill".
  Saving empty text is rejected with a pointer at the prefill dropdown.

## Empty-policy gate

The fixed prompt carries no policy, so an empty `Config.prompt` has nothing sensible to send.
A click with an empty policy behaves exactly like a missing API key: error run record
("No grouping policy set — pick a prefill or write one in the options."), badge error, options
page opened. Fresh installs therefore pick a prefill once during first setup.

## Limits

- `LIMITS.maxTabs: 100` — task-per-ticket grouping only pays off if the tickets fit in the
  candidate set; 100 keeps the request well inside budget for lightweight models.
- `LIMITS.nameMax: 32` — `KEY-123 + short topic` names otherwise truncate mid-key at 24.
  The built-in prefill additionally asks the model for ≤30-character names.
