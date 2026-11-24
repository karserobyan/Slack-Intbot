# Intent-driven answer card (short design)

Status: approved 2026-11-24. First plan task: check interpreter intent labels against the existing fixtures before writing any layout code. Size: a small change (card rendering, one plumbing line, two modal handlers, tests).

## Intent and why

New users find the answer card too long. Today every answer shows a research paragraph, every step in full, and a Draft block that repeats both. The first thing on the card should be what that person needs: the best guide when they ask "how do I…", the direct answer when they ask "what / why / is it allowed". The interpreter already labels each question (`how-to`, `integration-setup`, `policy`, `troubleshooting`, `unclear`) but nothing reads the label, so every question gets the same layout.

## Goals

- The card reads in about 8 lines. The most relevant thing is first.
- The layout follows the existing `intent` label. No new model call.
- Nothing is lost: full steps, the handoff draft and the research stay one click away.

## Non-goals

- No change to the resolver prompt, schema, models or search.
- No change to thread follow-up replies (already compact), the auto-answer card, the chat-resolution card, or the feedback flow.

## Anti-goals (a failure even if it works)

- A card with no visible source. Every card that has source refs keeps at least one linked source on the card itself, not only in the Sources modal.
- Hiding an escalation. When the honest answer is "hand this to another team", that handoff stays visible.
- An invented guide link. The lead guide is always one of the refs the research returned.

## Approaches considered

A. Layout chosen by the existing `intent` label (picked). B. The resolver decides style and best guide (more adaptive, but a prompt/schema change and a risk to the no-invention rule; keep as a later upgrade if A's labels prove too coarse). C. One compact layout for everyone (does not adapt to the question).

## Design

Plumbing: the pipeline attaches the interpreter's `intent` to the answer, carried like `_originalQuery` (transient, not shown).

`buildResponseBlocks` picks a layout from `intent`:

| Intent | Layout |
| --- | --- |
| `how-to`, `integration-setup` (guide) | Header. **Start here**: the best guide link (first KB or Confluence ref cited in the research, else the first KB ref, else the first Confluence ref; omitted if none). **Steps**: at most 5, each one line (bold title plus the first sentence of the detail, about 140 characters). Handoff line if another team is needed. |
| `policy`, `troubleshooting` (answer) | Header. **Answer**: the research text cut to at most 3 sentences, always keeping the citation sentence. **Next steps**: at most 3, one line each. Handoff line if another team is needed. |
| missing or `unclear` | Today's layout, unchanged (keeps existing tests and odd paths working). |

Buttons: `Full steps` (only when steps or details were cut), `Draft` (only when another team is needed; the draft is no longer inline), `Sources`, `Wrong answer`, `New chat` (DM only). The full research paragraph moves into the Full steps view.

Full steps and Draft open as modals. Content comes from the existing answer cache by the query already carried on the card; if the cache entry has expired, the modal says so and asks the person to ask again.

Step colour dots and the honest-handoff path ("No direct match found" plus the question as the draft) are kept.

## Left to the builder

- Exact sentence-splitting for the Answer lead; the 140-character one-line rule.
- Whether the modal content comes from the cache lookup (preferred) or is packed into the button value like Sources.
- Updating the card-shape tests (about 48 references to `buildResponseBlocks`; those without an intent stay on today's layout) and adding tests for both new layouts.

## Open item

The reply stage can still add customer-addressed text when a question mentions a customer. It would now show only inside the Draft modal. Whether to remove it entirely (gateway approval says no customer text) is a separate decision.

## Branching

Commit the model-alias gateway fix on its own first, then build this on a new `feature/intent-card` branch. Nothing is pushed without confirmation.
