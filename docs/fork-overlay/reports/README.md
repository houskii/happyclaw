# Sync Compatibility Reports

此目录用于存放每次 upstream 同步后的兼容性报告。

## 命名建议

使用日期前缀，便于按时间追踪：

- `2026-04-01-overlay-baseline.md`
- `2026-04-15-sync-upstream-main-<shortsha>.md`

## 最低要求

每份报告至少回答以下问题：

- 对应的 upstream 提交范围是什么；
- upstream 有哪些与 Claude / runner / provider 相关的变化；
- overlay replay 是否成功；
- 当前能力是否与 `capability-spec.md` 保持一致；
- 若不一致，偏移发生在哪里，结论是什么。
