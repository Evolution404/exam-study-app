import fs from "node:fs";

function rewriteLines(path, transform) {
  const source = fs.readFileSync(path, "utf8");
  const next = transform(source.split("\n"));
  fs.writeFileSync(path, next.join("\n"));
}

rewriteLines("scripts/tests/test-sync-event-ui.ts", (lines) => {
  const output = [];
  let insertedApplication = false;
  for (const line of lines) {
    if (line.includes("UI consumes the immutable v7 type contract")) {
      output.push(`assert.match(manager, /ChangeSetMutationV7,[\\s\\S]*ChangeSetV7,[\\s\\S]*from "@\\/lib\\/sync\\/sync-application"/, "UI consumes change-set types only through the public sync application contract");`);
      output.push(`assert.match(syncApplication, /from "\\.\\/change-set-v7"/, "sync application owns the v7 change-set implementation dependency");`);
      continue;
    }
    if (line.includes("drawer hot window state is loaded from the cached head")) {
      output.push(`assert.match(studyApp, /syncApplication\\.getHotWindow\\(settings\\)/, "drawer hot window state is loaded through the sync application boundary");`);
      continue;
    }
    if (line.includes("hot window panel is a live query over the local head cache")) {
      output.push(`assert.match(syncView, /const hotWindow = useLiveQuery\\(\\(\\) => syncApplication\\.getHotWindow\\(settings\\)/, "hot window panel is a live query through the application boundary");`);
      continue;
    }
    if (line.includes("last cache panel is a live query over the local checkpoint cache")) {
      output.push(`assert.match(syncView, /const lastCache = useLiveQuery\\(\\(\\) => syncApplication\\.getLastRemoteCache\\(settings\\)/, "last cache panel is a live query through the application boundary");`);
      continue;
    }
    output.push(line);
    if (!insertedApplication && line.startsWith("const packageJson =")) {
      output.push(`const syncApplication = await readFile(new URL("../../src/lib/sync/sync-application.ts", import.meta.url), "utf8");`);
      insertedApplication = true;
    }
  }
  if (!insertedApplication) throw new Error("test-sync-event-ui: packageJson anchor missing");
  if (output.some((line) => line.includes("UI consumes the immutable v7 type contract"))) throw new Error("test-sync-event-ui: old manager assertion remains");
  return output;
});

rewriteLines("scripts/tests/test-v7-ui-data-flow.ts", (lines) => {
  const output = [];
  let insertedRuntimeSources = false;
  for (const line of lines) {
    if (line.includes("自动同步应等浏览器空闲帧再触发")) {
      output.push(`assert.match(study, /syncRuntime\\.scheduleAutomaticSync/, "AppShell 应把自动同步调度委托给 runtime");`);
      output.push(`assert.match(syncRuntimeSource, /requestIdleCallback/, "runtime 应等浏览器空闲帧再触发自动同步，不撞答题反馈动画");`);
      continue;
    }
    if (line.includes("待同步计数应独立轻量订阅")) {
      output.push(`assert.match(study, /syncApplication\\.pendingCount\\(\\)/, "待同步计数应通过 application 轻量订阅，不与全表统计绑定");`);
      output.push(`assert.match(syncApplicationSource, /changeSets\\.where\\("state"\\)\\.anyOf\\(\\["pending", "blocked"\\]\\)\\.count\\(\\)/, "application 内部保留索引化轻量待同步计数");`);
      continue;
    }
    if (line.includes("快捷恢复完成态应留出可见时间")) {
      output.push(`assert.match(study, /syncApplication\\.restoreCache[\\s\\S]*setTimeout\\(resolve, 300\\)/, "快捷恢复经 application boundary 完成后仍应留出可见时间");`);
      continue;
    }
    if (!insertedRuntimeSources && line.startsWith("const syncOrchestrator =")) {
      output.push(`const syncRuntimeSource = readFileSync(new URL("../../src/lib/sync/sync-runtime.ts", import.meta.url), "utf8");`);
      output.push(`const syncApplicationSource = readFileSync(new URL("../../src/lib/sync/sync-application.ts", import.meta.url), "utf8");`);
      insertedRuntimeSources = true;
    }
    output.push(line);
  }
  if (!insertedRuntimeSources) throw new Error("test-v7-ui-data-flow: orchestrator anchor missing");
  if (output.some((line) => line.includes("assert.match(study, /requestIdleCallback/"))) throw new Error("test-v7-ui-data-flow: old idle assertion remains");
  return output;
});

console.log("sync boundary source tests migrated");
