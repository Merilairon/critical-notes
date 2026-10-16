## What and why

<!-- One or two sentences. Link the issue or task. -->

## Checklist

- [ ] `pnpm -s typecheck && pnpm -s lint && pnpm -s test` passes
- [ ] UI change: `pnpm e2e` passes (needs the local 5etools clone)
- [ ] Any endpoint returning campaign content projects it for players and has a sentinel string in `apps/server/test/visibility.test.ts` (MCP read tools included)
- [ ] New GM-only routes use `canActivate: [gmGuard]`
- [ ] Schema change: both `schema.ts` and `schema.pg.ts` updated, `pnpm --filter @cn/server db:generate` run, parity test passes
- [ ] No edition string comparisons, no raw HTML, Angular rules followed (see CONTRIBUTING.md)
- [ ] No 5etools data, `var/`, or traces and screenshots with rules text or art are included
- [ ] Behaviour change: `docs/STATUS.md` updated; any departure from the plan logged in `docs/PLAN.md`
- [ ] Commits use Conventional Commits and carry no co-author lines
- [ ] Every commit is signed off (`git commit -s`), agreeing to the [Developer Certificate of Origin](https://developercertificate.org/); contributions are under Apache-2.0, no CLA
