# DeerDawn context export

_Exported <timestamp> · schema v1_

## Profile

Solo builds export pipelines

**Working style:** Small commits

## Tool settings

- Briefs paused: no
- claude_web: on, light briefs
- chatgpt_web: on, light briefs
- cursor: on, light briefs
- claude_code: on, light briefs
- codex: on, light briefs

## Projects (2)

### Solo archived project (archived)

_Archived <timestamp> · Updated <timestamp>_

**Current task:** Finish the old work

**Source:** Created by context-sync API

#### Knowledge graph
- task: Finish the old work — Finish the old work

### Solo live project

_Updated <timestamp>_

**Description:** The live project

**Current task:** Write the renderer

**Status:** Halfway

**Goals:**
- Ship the importer

**Stack:**
- Postgres

**Decisions:**
- Render from keys — (<timestamp>)

**Open questions:**
- Cache the bundle?

**Task board:**
- **Backlog** (1)
  - Backlog card
    The detail of the card
- **Done** (1)
  - Done card

**Findings:**
- The cache collides under load — Paths: src/cache.js — (<timestamp>)

**Known paths:**
- export route: src/routes/export.js

**Source:** Created by context-sync API

#### Knowledge graph
- component: Export Pipeline — Renders the export bundle from the stored keys
- task: Write the renderer — Write the renderer

## Workspace entities (1)

_Knowledge filed for the whole workspace rather than one project._

- component: Shared Platform — Runs every export and import job for the workspace

## Skills (1)

### Release

How we release

```markdown
# Releasing

Tag, then deploy.
```
