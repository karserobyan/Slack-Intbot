# Intent-Driven Answer Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Slack answer card short and shaped by the question: a guide-first card for "how do I…" questions, an answer-first card for "what / why / is it allowed" questions.

**Architecture:** The interpreter's existing `intent` label is attached to the answer as `_intent`. `buildResponseBlocks` picks a compact layout from it (pure helpers in a new `answer-layout.js`). Full steps and the handoff draft move behind two buttons that open modals; their content comes from the answer cache by a short id carried in the button value.

**Tech Stack:** Node.js ESM, Slack Bolt + Block Kit, plain `assert` test script (`node test.js`).

**Spec:** `docs/superpowers/specs/2026-11-24-intent-driven-card-design.md`

## Global Constraints

- Node.js ESM only (`import`/`export`). No comments unless the why is non-obvious. No error handling for cases that cannot happen.
- Guide layout (`how-to`, `integration-setup`): header, **Start here** guide link, at most **5** steps, each one line of about **140** characters.
- Answer layout (`policy`, `troubleshooting`): header, **Answer** cut to at most **3 sentences** always keeping the citation sentence, at most **3** steps, one line each.
- Missing or `unclear` intent: today's layout, unchanged.
- Buttons, in order: `Full steps` (only when something was cut), `Draft` (only when another team is needed), `Sources`, `Wrong Answer`, `New chat` (DM only).
- Every card that has source refs keeps at least one linked source on the card itself. The guide link is always one of the returned refs. An honest handoff ("No direct match found") stays visible.
- No change to the resolver prompt/schema, models, search, thread follow-up replies, auto-answer card, chat-resolution card, or feedback flow.
- Keep Block Kit payloads well under Slack's 50-block limit. Section text at most 2900 characters, button `value` at most 2000.
- `node test.js` must end with 0 failures. Run it on a clean copy (no `.env`, no `data/`), with `ANTHROPIC_BASE_URL` unset, because local tokens and data leak into some mocks: `rsync -a --exclude node_modules --exclude .env --exclude .git --exclude data ./ "$TMPDIR/clean"/ && ln -s "$PWD/node_modules" "$TMPDIR/clean/node_modules" && (cd "$TMPDIR/clean" && env -u ANTHROPIC_BASE_URL node test.js | tail -5)`.
- Model names: the gateway account only accepts the aliases `integrationsbot-internal/chat-model` (sonnet-5-5) and `integrationsbot-internal/chat-model-fast` (haiku-5-5), set once in `src/claude/anthropic-config.js`. Raw `haiku-5-5` / `sonnet-5-5` return HTTP 403; never reintroduce them in code or docs.
- Never push or open a PR without the user's confirmation. Commit only the files a task names; never commit `package-lock.json`, `.env`, `data/`, or `AGENTS.md`.

## Review Focus

1. A guide-intent answer with no KB or Confluence refs: no "Start here" line, no crash, steps still shown (Task 3, Task 5).
2. A one-sentence or empty diagnosis: no empty section blocks (Slack rejects empty text) (Task 3, Task 5).
3. A cached answer replayed from `mention.js:265`: same compact layout, because `_intent` survives caching (Task 2).
4. Refs exist but the trimmed answer has no linked citation: a "Sources" line appears (Task 5).
5. Worst-case sizes: 20 long steps stays under 50 blocks and each section under 2900 characters; the Full steps modal stays under 100 blocks; an expired or unknown cache id opens an "expired" modal instead of throwing (Task 5, Task 6).

---

### Task 1: Branch and intent-label gate

**Files:**
- Modify (commit only): `src/claude/anthropic-config.js`, `test.js`, `.env.example`, `README.md`
- Create (not committed): a throwaway script in the session scratchpad directory

- [ ] **Step 1: Confirm the gateway fix is the only change in those four files.** Run `git diff --stat src/claude/anthropic-config.js test.js .env.example README.md` and check the diff is the model-alias change only.
- [ ] **Step 2: Commit the gateway fix** with `git add` of those four files only, message `fix: use the gateway virtual-account model aliases`.
- [ ] **Step 3: Create the branch:** `git checkout -b feature/intent-card`.
- [ ] **Step 4: Run the existing fixture gate:** `env -u ANTHROPIC_BASE_URL node scripts/run-interpreter-fixtures.js`. Expected: all fixtures pass.
- [ ] **Step 5: Label check.** In a scratchpad script, call `runInterpreter(question)` from `src/claude/interpreter.js` for each question below and print `intent`.
  - Guide wording, expect `how-to` or `integration-setup`: "How do I set up the QuickBooks Online integration for a new tenant?", "Where do I find the Zapier client ID and secret?", "Steps to connect Google Local Services Ads to a tenant", "How to map custom fields between Zapier and the CRM".
  - Info wording, expect `policy` or `troubleshooting`: "Why is the QuickBooks sync failing with a 401?", "Can a customer have more than one Zapier connection?", "Is there a freeze on new Zapier activations?", "Zapier stopped syncing jobs yesterday".
- [ ] **Step 6: Gate.** Pass if at least 7 of 8 land in the expected group and none is `unclear`. If it fails, stop and report the table to the user; the design says to reconsider approach B.

### Task 2: Carry the intent on the answer

**Files:**
- Modify: `src/claude/pipeline.js` (next to `answer._cleanedQuestion = interp.cleaned_question;`, around line 234)
- Test: `test.js` (pipeline section containing `okPipeResult`)

**Interfaces:**
- Produces: `answer._intent: string`, the interpreter's `intent`. It is not added to `TRANSIENT_FIELDS` in `src/handlers/mention.js`, so it is cached with the answer (same query, same intent).

- [ ] **Step 1: Write the failing test** in the pipeline section: `assert(okPipeResult._intent === <the intent in that test's interpreter mock>, 'the pipeline attaches the interpreter intent')`, and `assert(stripTransient(okPipeResult)._intent === okPipeResult._intent, 'the intent survives caching')` (import `stripTransient` from `src/handlers/mention.js` if not already imported).
- [ ] **Step 2: Run `node test.js` and confirm those two assertions fail.**
- [ ] **Step 3: Set `answer._intent = interp.intent;`** beside `_cleanedQuestion`.
- [ ] **Step 4: Run `node test.js` (clean copy) and confirm both pass and nothing else changed.**
- [ ] **Step 5: Commit** `src/claude/pipeline.js test.js` with `feat: attach the interpreter intent to the answer`.

### Task 3: Pure layout helpers

**Files:**
- Create: `src/slack/answer-layout.js`
- Test: `test.js` (new section `🔹 Answer layout helpers`, imports at the top of the file)

**Interfaces:**
- Produces:
  - `layoutFor(intent: string | undefined): 'guide' | 'answer' | 'legacy'` (`how-to` and `integration-setup` give `guide`; `policy` and `troubleshooting` give `answer`; anything else gives `legacy`).
  - `pickGuide(data: { diagnosis?: string, kb_refs?: Ref[], atlassian_refs?: Ref[] }): { title: string, url: string } | null`. Order: a KB or Confluence ref whose title appears in the diagnosis (case-insensitive), KB before Confluence; else the first KB ref; else the first Confluence ref; else `null`. Jira and Slack refs are never chosen.
  - `trimToSentences(text: string, maxSentences: number, opts?: { keepLast?: boolean }): string`. Splits where terminal punctuation is followed by whitespace and a capital letter or `<`. If the text has no more than `maxSentences` sentences, returns it unchanged; otherwise returns the first `maxSentences - 1` plus the last when `keepLast`, else the first `maxSentences`.
  - `oneLineStep(step: { detail?: string }, max?: number): string` (default `max` 140). Returns the first sentence of the detail, hard-cut at `max` with `…`.

- [ ] **Step 1: Write the failing tests** with these names and assertions:
  - `layoutFor`: `how-to` and `integration-setup` give `'guide'`; `policy` and `troubleshooting` give `'answer'`; `'unclear'`, `undefined` and `'nonsense'` give `'legacy'`.
  - `pickGuide`: picks the KB ref whose title is quoted in the diagnosis; falls back to the first KB ref; falls back to Confluence; returns `null` when only Jira and Slack refs exist; returns `null` with no refs.
  - `trimToSentences`: a 5-sentence text with `keepLast` returns 2 sentences plus the last; a 2-sentence text is unchanged; empty string stays empty; `"Use e.g. the admin page. Then save."` is not split after `e.g.`.
  - `oneLineStep`: returns only the first sentence; a 300-character single sentence ends with `…` and has length at most 140; a missing detail returns `''`.
- [ ] **Step 2: Run `node test.js` and confirm the new tests fail (module missing).**
- [ ] **Step 3: Implement the four functions** in `src/slack/answer-layout.js` as pure functions with no Slack imports.
- [ ] **Step 4: Run `node test.js` (clean copy) and confirm the new tests pass.**
- [ ] **Step 5: Commit** `src/slack/answer-layout.js test.js` with `feat: add answer layout helpers`.

### Task 4: Short ids in the answer cache

**Files:**
- Modify: `src/slack/cache.js`
- Test: `test.js` (existing cache section)

**Interfaces:**
- Produces: `shortId(query: string): string` (first 12 hex characters of the SHA-1 of `cacheKey(query)`) and `getCachedById(id: string): object | null` (scans the store for a non-expired entry whose key hashes to `id`; counts as a hit or miss like `getCached`).

- [ ] **Step 1: Write the failing tests:** after `setCached('Zapier API access', obj)`, `getCachedById(shortId('  zapier   API ACCESS '))` returns `obj`; `getCachedById('000000000000')` returns `null`; `shortId` of the raw and the cleaned phrasing of the same normalised query is equal; an expired entry returns `null`.
- [ ] **Step 2: Run `node test.js` and confirm they fail.**
- [ ] **Step 3: Implement both functions in `cache.js`** (use `node:crypto`; reuse the existing expiry check).
- [ ] **Step 4: Run `node test.js` (clean copy) and confirm they pass.**
- [ ] **Step 5: Commit** `src/slack/cache.js test.js` with `feat: look up cached answers by short id`.

### Task 5: Compact layouts in `buildResponseBlocks`

**Files:**
- Modify: `src/slack/blocks.js` (`buildResponseBlocks`, around lines 199-312; extract the existing step-rendering loop)
- Test: `test.js` (new section `🔹 Intent-driven card`, after the existing `buildResponseBlocks` section near line 436)

**Interfaces:**
- Consumes: `layoutFor`, `pickGuide`, `trimToSentences`, `oneLineStep` from `src/slack/answer-layout.js`; `shortId` from `src/slack/cache.js`; existing `linkifyCitations`, `handoffDraftText`, `isHonestHandoff`, `visibleSlackRefs`, `encodeActionText`.
- Produces: `buildStepBlocks(steps: Step[]): Block[]` (the existing per-step section blocks, extracted unchanged and reused by the legacy path and the Full steps modal in Task 6). `buildResponseBlocks(data, { isDm })` now branches on `layoutFor(data._intent)`; the `legacy` branch is today's code path. New buttons `view_full_steps_modal` and `view_draft_modal` carry `value: JSON.stringify({ id: shortId(data._originalQuery) })`.

- [ ] **Step 1: Write the failing tests** (build data from `sampleJson` plus `_intent` and `_originalQuery`):
  - Guide: `_intent: 'how-to'` gives a section starting `*Start here*` containing the KB ref link; no `*Research*` and no `*Draft*` text; at most 5 step blocks, each text at most about 140 characters of detail.
  - Answer: `_intent: 'troubleshooting'` gives an `*Answer*` section with at most 3 sentences that still contains the citation link when the diagnosis cites one; at most 3 step blocks.
  - Legacy: no `_intent`, and `_intent: 'unclear'`, render exactly as before (existing tests keep passing; add one equality check against the unmodified builder output for `sampleJson`).
  - Buttons: `Full steps` exists only when steps were cut; `Draft` exists only when `involvement.needed` and a draft exists; order is Full steps, Draft, Sources, Wrong Answer, New chat.
  - Review Focus 1: guide intent with only Jira and Slack refs has no `*Start here*` and still has steps.
  - Review Focus 2: empty diagnosis and a one-sentence diagnosis produce no section with empty text.
  - Review Focus 4: refs exist but the diagnosis has no citation label, so the card has a `Sources:` context block with at most 3 links.
  - Review Focus 5: 20 steps with 500-character titles and details gives fewer than 50 blocks and every section text at most 2900 characters; honest-handoff data still renders `No direct match found` and a `Draft` button when a team is needed.
- [ ] **Step 2: Run `node test.js` and confirm the new tests fail.**
- [ ] **Step 3: Extract `buildStepBlocks`** from the existing loop without changing output; run `node test.js` and confirm all earlier tests still pass.
- [ ] **Step 4: Implement the guide and answer branches** in `buildResponseBlocks` per the Global Constraints; add the `Sources:` fallback context block when refs exist and no `<http` link is in the rendered lead or steps.
- [ ] **Step 5: Run `node test.js` (clean copy) and confirm everything passes.**
- [ ] **Step 6: Commit** `src/slack/blocks.js test.js` with `feat: shape the answer card by question intent`.

### Task 6: Full steps and Draft modals

**Files:**
- Modify: `src/slack/blocks.js` (new builders), `src/index.js` (two handlers next to `view_sources_modal`, around line 82)
- Test: `test.js`

**Interfaces:**
- Consumes: `getCachedById` (Task 4), `buildStepBlocks`, `researchSummaryText`, `handoffDraftText`, `visibleSlackRefs` (Task 5 and existing). The cached view has no `_originalQuery` (it is stripped before caching), so an honest-handoff draft in the modal falls back to `issue_title`; accept that.
- Produces: `buildFullStepsModal(data): View` (title `Full steps`; research paragraph, then all steps via `buildStepBlocks`), `buildDraftModal(data): View` (title `Handoff draft`; the draft text without its `*Draft*` heading), `buildExpiredModal(): View` (title `Answer expired`; one line asking the person to ask again). Handlers for `view_full_steps_modal` and `view_draft_modal`: `ack()`, parse `action.value` JSON, `getCachedById(id)`, open the matching modal, or `buildExpiredModal()` on a miss or bad JSON; log failures like the Sources handler.

- [ ] **Step 1: Write the failing tests:** `buildFullStepsModal` contains the research text and one block per step, fewer than 100 blocks for 20 steps; `buildDraftModal` has the draft text and no `*Draft*` heading; `buildExpiredModal` has the title `Answer expired`; every modal title is at most 24 characters.
- [ ] **Step 2: Run `node test.js` and confirm they fail.**
- [ ] **Step 3: Implement the three builders** in `blocks.js` and the two handlers in `index.js`.
- [ ] **Step 4: Run `node test.js` (clean copy) and confirm everything passes.**
- [ ] **Step 5: Commit** `src/slack/blocks.js src/index.js test.js` with `feat: open full steps and the handoff draft in modals`.

### Task 7: Docs and live check

**Files:**
- Modify: `docs/functionality-overview.md` (the card description section)

- [ ] **Step 1: Update the card description** in `docs/functionality-overview.md` to describe the two layouts, the buttons, and the one-hour expiry of Full steps and Draft. In the same commit, replace the stale raw model names (`haiku-5-5` / `sonnet-5-5` presented as what the bot sends) with the aliases or an "alias (haiku-5-5)" form in `process.md` (line 23), `docs/functionality-overview.md` (line 10), `docs/bot-briefing.md` (line 73), `.cursor/skills/integrationsbot/SKILL.md` (lines 47, 54, 55) and the operator hint in `scripts/smoke-kb-search.js` (line 78). Add `scripts/smoke-kb-search.js` and those docs to the commit's file list.
- [ ] **Step 2: Run the full suite on a clean copy** (command in Global Constraints) and confirm `0 failed`.
- [ ] **Step 3: Live render check.** In a scratchpad script, run `runPipeline` (from `src/claude/pipeline.js`) for one guide-wording and one info-wording question, build `buildResponseBlocks({ ...result, _originalQuery: question })`, and print the block texts. Expected: the guide question starts with a guide link; the info question starts with a short answer; neither contains a duplicated Draft.
- [ ] **Step 4: Commit** `docs/functionality-overview.md` with `docs: describe the intent-driven answer card`.
- [ ] **Step 5: Ask the user to run the bot (`env -u ANTHROPIC_BASE_URL npm start`) and DM it one guide question and one info question to confirm the buttons and modals in Slack.** Do not push or open a PR until they confirm.
