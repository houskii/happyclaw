# Upstream Sync Trial Report

## Summary

- Trial date: 2026-04-01
- Trial branch: `p/pengzipei/upstream-sync-trial`
- Overlay baseline branch: `p/pengzipei/fork-overlay-governance`
- Upstream target: `upstream/main`
- Upstream revision: `f14a05fab88c29f1ac2cb2c304eb3249cb55d921`
- Current status: in progress

## Initial Assessment

- The repository has high historical divergence from `upstream/main`.
- The divergence is not limited to documentation or isolated adapters.
- Directly impacted areas include runtime entrypoints, provider runtime, IM routing, configuration routes, shared types, and the web settings surface.

## Early Signals

- `git diff --stat HEAD..upstream/main` reports large-scale churn across backend, runner, and web modules.
- `git log --left-right --cherry-pick HEAD...upstream/main` shows substantial parallel evolution on both sides.
- The overlay-specific governance documents and scripts added in branch 1 are absent from upstream and must be preserved across the sync.

## Expected Conflict Zones

- `src/index.ts`
- `src/routes/config.ts`
- `container/agent-runner/src/index.ts`
- `container/agent-runner/src/mcp-tools.ts`
- `shared/stream-event.ts`
- provider-specific runtime modules under `container/agent-runner/src/providers/`
- web settings and provider management components

## Working Notes

- Initial strategy is to attempt a direct merge on the trial branch to expose the real conflict surface.
- If the merge surface proves too large to stabilize safely in one pass, the next fallback is to switch from a direct merge to a replay-based transplant of overlay capabilities onto the upstream base.

## Direct Merge Attempt

- Command:
  - `git merge --no-commit --no-ff upstream/main`
- Result:
  - merge started but did not complete
  - automatic merge failed with conflicts
- Conflict count:
  - `73` unresolved files

## Conflict Distribution

- Runtime and orchestration:
  - `src/index.ts`
  - `src/container-runner.ts`
  - `src/group-queue.ts`
  - `src/task-scheduler.ts`
  - `src/web.ts`
- Provider and runner surface:
  - `container/agent-runner/src/index.ts`
  - `container/agent-runner/src/mcp-tools.ts`
  - `container/agent-runner/src/types.ts`
  - `container/agent-runner/src/providers/claude/claude-stream-processor.ts`
  - `src/runtime-config.ts`
  - `src/schemas.ts`
- IM and channel routing:
  - `src/feishu.ts`
  - `src/feishu-streaming-card.ts`
  - `src/im-channel.ts`
  - `src/im-manager.ts`
  - `src/qq.ts`
  - `src/telegram.ts`
  - `src/wechat.ts`
- Route layer:
  - `src/routes/config.ts`
  - `src/routes/groups.ts`
  - `src/routes/memory.ts`
  - `src/routes/skills.ts`
  - `src/routes/tasks.ts`
  - `src/routes/agent-definitions.ts`
- Web chat and settings:
  - `web/src/pages/ChatPage.tsx`
  - `web/src/pages/SettingsPage.tsx`
  - `web/src/components/chat/*`
  - `web/src/components/settings/*`
  - `web/src/stores/chat.ts`
  - `web/src/stores/skills.ts`
  - `web/src/stores/tasks.ts`

## Interim Conclusion

- A direct merge is technically possible but currently too broad to be treated as a routine sync.
- The conflict surface confirms that the fork and upstream have both evolved in the same high-churn zones.
- This validates the original governance assumption: upstream sync must be treated as an overlay re-application problem, not as a conventional low-touch merge.

## Replay Trial

- Scratch base:
  - clean branch created from `upstream/main`
- First replay layer tested:
  - `provider-boundary`
- First commit tested:
  - `e85d804`
- Command:
  - `git cherry-pick --no-commit e85d804`
- Result:
  - replay did not fan out into broad repository conflicts
  - only one unresolved conflict was produced
- Conflict focus:
  - `container/agent-runner/src/index.ts`
- Additional staged change from replay:
  - `container/agent-runner/src/query-loop.ts`

## Replay Interpretation

- Replay-based sync substantially narrows the conflict surface compared with direct merge.
- The first replay failure happened exactly at a high-value overlay boundary file, which is a workable and expected result.
- This indicates the fork should be migrated by re-applying overlay layers on top of the upstream runtime shape, instead of trying to preserve the current fork tree through a broad merge.

## Recommended Next Step

- Freeze the direct-merge path as an assessment artifact only.
- Treat `container/agent-runner/src/index.ts` as the first explicit adaptation boundary.
- Continue replay in layer order, resolving boundary conflicts one layer at a time and updating the capability report after each resolved layer.

## Open Questions

- Whether the current Codex provider architecture can be preserved with incremental conflict resolution, or whether it must be re-applied onto the upstream runtime shape.
- Whether the fork can continue to keep provider governance mostly in the existing boundaries, given upstream changes around configuration and UI structure.
