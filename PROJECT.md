# NoteDown — Project Documentation

## What this is

NoteDown is a cross-platform notes app for Android, iOS and the web. The
project is in its **concept phase**: the goal is to work out the
functional scope and the operating concept (Bedienkonzept) with
requirements and clickable HTML mockups before any app code is written.
Turning the concept into an app — technology, storage, sync — is a later
phase and gets its
own decisions in `docs/requirements.md`.

What the repo holds today:

| Path | Content |
|---|---|
| `docs/requirements.md` | The decided functional scope, by area, each item with its reason and mockup |
| `docs/interaction-concept.md` | Cross-cutting operating rules: navigation, gestures, shortcuts, tier behavior |
| `mockups/` | The decided UI as self-contained HTML pages (see "Mockup conventions") |
| `FEATURE_BACKLOG.md` | Ideas not yet decided, with priority and effort |
| `scripts/` | `doc-toc.js` (Markdown TOCs), `screenshot.js` (mockup screenshots), `branch-status.sh` (session-start hook) |

## Device tiers

Every mockup is designed and checked in these three tiers. The numbers
are the viewports `scripts/screenshot.js --device` uses.

| Tier | Viewport (CSS px) | Input |
|---|---|---|
| desktop | 1440×900 | mouse + hardware keyboard |
| tablet | 820×1180 portrait | touch only + on-screen keyboard |
| phone | 390×844 | touch only + on-screen keyboard |

How a feature adapts between the tiers (layout, which controls move into
menus or sheets) is part of each decision; the general rules are in
`docs/interaction-concept.md`.

## Mockup conventions

- **Decision mockups** (variants A/B/C for the user to choose from) are
  Artifacts, not repo files (`orchestrate` → `mockup.md`). Only the
  decided variant is built into `mockups/`.
- **Repo mockups** in `mockups/`: one HTML page per area or flow
  (`mockups/<area>.html`), plain HTML/CSS/JS, no framework, no build step,
  no external requests — each page opens directly from the file system.
  `mockups/index.html` links all pages once there is more than one.
- **Shared parts** in `mockups/shared/`, loaded with relative paths:
  design tokens (`tokens.css`: colors for light and dark, spacing, type
  sizes) and the sample content (`sample-data.js`: notebooks, notes, tags
  — the only source of example content, CLAUDE.md). Both are created with
  the first mockup and grow with the concept.
- A mockup shows behavior, not just pixels: the interactions the decision
  is about are clickable (open/close, select, switch views); persistence
  is faked in memory.
- The tier is chosen by CSS media queries on the viewport, like the real
  app would, so a screenshot in each `--device` shows that tier's layout.

## Screenshots

```bash
NODE_PATH="$(npm root -g)" node scripts/screenshot.js mockups/<page>.html \
  --device phone --theme dark --out <scratchpad>/shot-<page>-phone-dark.png \
  [--eval "<js that opens the state to show>"]
```

The script lists page errors after the shot and exits non-zero on them.
Options are documented in its header.

## Where everything else lives

- `docs/requirements.md` — what NoteDown does (decided), and the open
  questions that block a decision.
- `docs/interaction-concept.md` — how NoteDown is operated across tiers.
- `FEATURE_BACKLOG.md` — what might come; entries leave it when their
  requirement is decided and mocked.
