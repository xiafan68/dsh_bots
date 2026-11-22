# dsh-bots 文档

这个插件是「Bot + 共享任务看板」：人可以直接和 bot 私聊派活，也可以把活变成任务；主控 bot 负责分派，并在完成后汇总。下面按「你想知道什么」来索引。

| 页面 | 讲什么 | 适合谁读 |
| --- | --- | --- |
| [requirements.md](requirements.md) | 需求文档（草案 v0.2）：要解决什么问题、边界在哪、参考了哪个实现 | 想知道「为什么长这样」的人 |
| [implementation-notes.md](implementation-notes.md) | 实现笔记 v1：这一版怎么搭的、踩过哪些坑、下一轮从哪接 | 接手维护代码的人 |
| [verification.md](verification.md) | 端到端验证记录：真实宿主 + 独立 CLI 实例 + headless Chrome 的实测过程与截图 | 想确认「真的能跑」的人 |
| [interaction-shift.md](interaction-shift.md) | 交互形态变迁分析：从「人给每个任务建会话指派」到「跟主控 bot 说 → 主控记任务并分派」 | 关心产品形态与适用边界的人 |
| [model-assumptions.md](model-assumptions.md) | 模型假设分析：这套「主控 Bot + 任务板」协议对模型能力的要求 | 想换模型、或评估能不能跑起来的人 |

## 读的顺序

第一次接触这个插件，建议 `requirements.md` → `interaction-shift.md` → `implementation-notes.md`。
只想知道能不能用，直接看 `verification.md`。

## 不在本目录的文档

- 仓库根 [README.md](../README.md)：功能清单、安装方式、已知边界、数据位置。