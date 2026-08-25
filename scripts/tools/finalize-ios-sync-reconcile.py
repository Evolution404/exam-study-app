from pathlib import Path
import json

orchestrator = Path("src/lib/sync/sync-v7-orchestrator.ts")
text = orchestrator.read_text()
old = '''      report(progress, "merge", `正在写入 ${rebasedProjection.questions.length.toLocaleString("zh-CN")} 道题与 ${rebasedProjection.attempts.length.toLocaleString("zh-CN")} 条作答到本机`, bandPercent(bands.install, 0.3), bands.install[1]);
      const installed = await installProjection(rebasedProjection, { queueGuard: queueSnapshot });
      if (!installed) continue;
      report(progress, "merge", "本机数据已更新", bandPercent(bands.install, 1), bands.install[1]);'''
new = '''      report(progress, "merge", `正在比较本机数据（远端 ${rebasedProjection.questions.length.toLocaleString("zh-CN")} 道题、${rebasedProjection.attempts.length.toLocaleString("zh-CN")} 条作答）`, bandPercent(bands.install, 0.02), bands.install[1]);
      const installed = await installProjection(rebasedProjection, {
        queueGuard: queueSnapshot,
        onProgress: ({ completed, total, label }) => {
          const fraction = total ? completed / total : 1;
          report(progress, "merge", `${label}（${completed.toLocaleString("zh-CN")}/${total.toLocaleString("zh-CN")}）`, bandPercent(bands.install, fraction), bands.install[1]);
        },
      });
      if (!installed) continue;
      report(progress, "merge", "本机数据已更新", bandPercent(bands.install, 1), bands.install[1]);'''
if old not in text:
    raise SystemExit("orchestrator install block not found")
orchestrator.write_text(text.replace(old, new, 1))

package = Path("package.json")
data = json.loads(package.read_text())
scripts = data["scripts"]
if "test:sync-incremental-install" not in scripts:
    rebuilt = {}
    for key, value in scripts.items():
        rebuilt[key] = value
        if key == "test:sync-install-fingerprint":
            rebuilt["test:sync-incremental-install"] = "tsx scripts/tests/test-sync-incremental-install.ts"
    data["scripts"] = rebuilt
package.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")

groups = Path("scripts/tools/test-groups.mjs")
text = groups.read_text()
marker = '    "test:sync-install-fingerprint",\n'
addition = marker + '    "test:sync-incremental-install",\n'
if '"test:sync-incremental-install"' not in text:
    if marker not in text:
        raise SystemExit("integration registration marker not found")
    text = text.replace(marker, addition, 1)
groups.write_text(text)

progress = Path("scripts/tests/test-sync-progress.ts")
text = progress.read_text()
marker = '  assert.ok(pull.reports.some((report) => report.phase === "merge" && /写入/.test(report.label)), "拉取应报告本机写入进度");\n'
addition = marker + '  assert.ok(pull.reports.some((report) => report.phase === "merge" && /(更新题目|更新作答记录|本机增量更新完成)/.test(report.label) && /（\\d+\\/\\d+）/.test(report.label)), "拉取应透传本机 reconcile 的真实 completed/total 进度");\n'
if "reconcile 的真实 completed/total" not in text:
    if marker not in text:
        raise SystemExit("sync progress assertion marker not found")
    text = text.replace(marker, addition, 1)
progress.write_text(text)

Path("scripts/tools/finalize-ios-sync-reconcile.py").unlink(missing_ok=True)
