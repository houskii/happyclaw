# Fork Overlay

`Fork Overlay` 目录用于记录这个 fork 相对 upstream 的稳定增强层，并为后续主干同步提供统一依据。

## 目录说明

- `overlay-ledger.json`
  机器可读账本，描述 overlay 版本、能力清单、稳定承诺、同步配置和 replay 分层。
- `capability-spec.md`
  当前 overlay 能力基线，回答“这个 fork 现在理论上应该具备什么能力”。
- `change-log.md`
  overlay 能力变化记录，回答“能力定义在什么时候发生过变化”。
- `reports/`
  每次同步后的兼容性报告，回答“这次同步之后能力有没有偏移”。
- `templates/`
  兼容性报告模板。

## 使用方式

1. 更新 upstream 基线前，先阅读 `capability-spec.md`，明确当前必须保真的能力。
2. 根据 `overlay-ledger.json` 中的 `sync.replayLayers` 重建 overlay。
3. 运行 `make overlay-check`，确认账本和文档结构有效。
4. 完成同步或适配后，基于 `templates/sync-compatibility-report.md` 新建一份报告放入 `reports/`。
5. 如果能力定义发生变化，同时更新 `change-log.md` 与 `overlay-ledger.json`。

## 判定标准

同步成功不只意味着代码可以编译运行，还意味着：

- `capability-spec.md` 中声明的稳定能力仍然成立；
- `reports/` 中给出了本次同步的结论；
- 若能力发生变化，该变化已被明确记录在 `change-log.md` 中。
