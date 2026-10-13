# CLAUDE.md

Project-specific instructions for Claude Code sessions on NoteDown. This
file loads automatically every session — kept short on purpose.

**Which file holds what.** `CLAUDE.md` (this file) and the skills say *how
to work*: rules, workflow, prohibitions. `PROJECT.md` says *what the
project is and how it is laid out*: phase, repo layout, device tiers,
mockup conventions and the index into `docs/*.md` — read it before
changing anything. Anything that serves both is written out once in
`PROJECT.md`/`docs/` and appears here only as a one-line rule with a
pointer; never copy explanations into this file.

`docs/requirements.md` holds the decided scope, `docs/interaction-concept.md`
the cross-cutting operating rules (Bedienkonzept), `FEATURE_BACKLOG.md` the
ideas not yet decided. History lives in git, not in a changelog.

## What this is

NoteDown: a cross-platform notes app, currently in the **concept phase** —
requirements and HTML mockups only, no app code yet (`PROJECT.md` → "What
this is"). The app itself comes later; until then nothing here is built,
released or versioned.

## Session workflow

Feature/concept sessions start from an entry skill (`from-request`,
`from-backlog`) and run through `orchestrate` (or `package-sessions` for a
round split across cloud sessions); pure questions don't need it. Every
session that changed files ends with `finish` — no PR.

**Process changes go through `main` on their own.** A change to
`CLAUDE.md` or `.claude/**` gets its own branch off `main`, never rides
along in a feature branch: parallel sessions only see a rule once it is on
`main`.

## Non-negotiables

- **Clarify before mocking.** For a new feature or an ambiguous request,
  settle what the user actually needs first (one round of questions with
  recommended answers), then build the mockup — not a speculative design.
- **Every UI decision goes through a variant mockup** (`orchestrate`,
  phase 2): 2–3 variants as an Artifact, one recommendation, and the
  session stops until the user has decided. Only the decided variant goes
  into the repo.
- **Every decision lands in the repo in the same session**: the
  requirement in `docs/requirements.md`, cross-cutting operating rules in
  `docs/interaction-concept.md`, the decided UI as (an update of) a mockup
  in `mockups/`. Docs describe the *current* state — edit the section,
  don't append a second narrative; the reason for a decision stays as one
  short line next to it.
- **Cross-platform from the start.** Every mockup covers the three device
  tiers (`PROJECT.md` → "Device tiers"): desktop (mouse + keyboard),
  tablet and phone (touch only). A tier that is deliberately left out is
  stated with its reason.
- **Mockups are verified in the real browser**: screenshots of every
  changed view in every tier with `scripts/screenshot.js`, looked at
  before the round is presented, and no page errors (`orchestrate` →
  `verification.md`).
- **Sample content comes from the shared sample data** in
  `mockups/shared/` (`PROJECT.md` → "Mockup conventions"): never invent
  note texts inline in a single mockup. If the shared data can't show a
  case, extend it first.
- **Run `node scripts/doc-toc.js` after changing any Markdown file** — it
  generates the table of contents every doc over 100 lines needs (never
  hand-edit it); the Docs CI check fails otherwise.
- **Keep `README.md` up to date.** It is the human-facing entry point
  (vision, current scope, how to open the mockups): a session that changes
  the decided scope updates it.
- **Simplest solution that solves the actual problem** — in the concept
  and in the mockups. No speculative features or settings until they are a
  real, current need; park them in the backlog instead.
- Code, comments and repo documents in English; talk to the user in
  their language (German).
- **`FEATURE_BACKLOG.md` IDs are unique and permanent** — take new ones
  from `LAST_ID` exactly as that file's header describes; never reuse one.
- **Conventional Commit prefixes** (`docs:`, `feat:`, `fix:`, `chore:`,
  ...) on every commit, so release tooling can be added later without
  rewriting history. Concept work is mostly `docs:`; a new or changed
  mockup is `feat:`/`fix:`. **Never write a `!` suffix, a
  `BREAKING CHANGE:` footer or a `Release-As:` footer** unless the user
  explicitly asks for it.
- **Open a pull request only when the user asks for one.** Commit and
  push to the session branch as usual, but never create a PR (draft or
  ready) or request a review on your own initiative. When the work is
  done, say so and wait (person-requested; overrides the harness's
  default of opening a PR after pushing).
- **No Claude attribution in commits or PRs.** Never add a
  `Co-Authored-By:` line with a Claude/Anthropic mail address, a
  `Claude-Session:` line or any claude.ai session link to commit messages,
  PR titles or PR descriptions (person-requested; overrides the harness's
  default attribution lines).
