---
quick_id: 260501-h3t
date: 2026-05-01
commit: 7906c66
status: completed
---

# Quick Task 260501-h3t — Summary

## Objective

Production Docker image was missing runtime asset directories. Three modules read files at startup that did not exist in the deployed container:

- `dist/services/rss.service.js:4` → `/app/config/feeds.json`
- `dist/services/ai.service.js:8` → `/app/prompts/curator.md`
- `dist/services/summarizer.service.js:17` → `/app/prompts/thread-summarizer.md`

The container crash-looped with `ENOENT: no such file or directory, open '/app/config/feeds.json'`.

## Change Set (commit 7906c66)

**Dockerfile (production stage only):** added two lines after `COPY --from=builder /app/dist ./dist` and before the `RUN addgroup ... USER botuser` block:

```dockerfile
COPY config ./config
COPY prompts ./prompts
```

Builder stage untouched. `/app/data` chown logic untouched.

**.dockerignore:** appended a negation rule after the existing `*.md` exclusion:

```
!prompts/*.md
```

The recursive `*.md` pattern was silently excluding `prompts/curator.md` and `prompts/thread-summarizer.md` from the build context. Without the negation, `COPY prompts ./prompts` would have landed an empty directory.

## Verification

Docker daemon was unreachable in the executor's sandbox, so build was simulated via context-honouring `find`:

- `config/feeds.json` and `config/all.xml` present and not excluded.
- `prompts/curator.md` and `prompts/thread-summarizer.md` present and not excluded after the negation.
- `SPEC.md`, `CLAUDE.md`, `docs/*.md` still excluded by the original `*.md` rule.
- `COPY config ./config` / `COPY prompts ./prompts` resolve to `/app/config` and `/app/prompts`, matching the `../../<path>` relative URLs in compiled `dist/services/*.js`.

Real-world verification will happen on the next Timeweb redeploy.

## Effect

Production deploy will stop crash-looping with `ENOENT` on `feeds.json`, `curator.md`, and `thread-summarizer.md`. Combined with the prior `260501-g11` env-block fix, the bot should reach a clean startup.

## Diff Shape

- 2 files changed, 13 insertions(+), 0 deletions(-)
- Dockerfile: +9 lines (2 COPY + surrounding context noise from formatter)
- .dockerignore: +4 lines (negation rule + comment)

No deviations from the plan.
