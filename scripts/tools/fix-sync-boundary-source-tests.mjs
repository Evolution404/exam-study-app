import fs from "node:fs";

function replace(path, replacements) {
  let source = fs.readFileSync(path, "utf8");
  for (const [from, to, label] of replacements) {
    if (!source.includes(from)) throw new Error(`sync boundary test migration missing ${label} in ${path}`);
    source = source.replace(from, to);
  }
  fs.writeFileSync(path, source);
}

replace("scripts/tests/test-sync-event-ui.ts", [
  [
    `const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));\n`,
    `const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));\nconst syncApplication = await readFile(new URL("../../src/lib/sync/sync-application.ts", import.meta.url), "utf8");\n`,
    "sync application source",
  ],
  [
    `assert.match(manager, /import type \\{ ChangeSetMutationV7, ChangeSetV7 \\} from "@\\/lib\\/sync\\/change-set-v7"/, "UI consumes the immutable v7 type contract without owning persistence");`,
    `assert.match(manager, /ChangeSetMutationV7,[\\s\\S]*ChangeSetV7,[\\s\\S]*from "@\\/lib\\/sync\\/sync-application"/, "UI consumes change-set types only through the public sync application contract");\nassert.match(syncApplication, /from "\\.\\/change-set-v7"/, "sync application owns the v7 change-set implementation dependency");`,
    "manager type boundary assertion",
  ],
  [
    `assert.match(studyApp, /getSyncHotWindowState\\(settings\\)/, "drawer hot window state is loaded from the cached head");`,
    `assert.match(studyApp, /syncApplication\\.getHotWindow\\(settings\\)/, "drawer hot window state is loaded through the sync application boundary");`,
    "drawer hot window assertion",
  ],
  [
    `assert.match(syncView, /const hotWindow = useLiveQuery\\(\\(\\) => \\(settings\\.owner && settings\\.repo \\? getSyncHotWindowState\\(settings\\)/, "hot window panel is a live query over the local head cache");\nassert.match(syncView, /const lastCache = useLiveQuery\\(\\(\\) => \\(settings\\.owner && settings\\.repo \\? getLastRemoteCache\\(settings\\)/, "last cache panel is a live query over the local checkpoint cache");`,
    `assert.match(syncView, /const hotWindow = useLiveQuery\\(\\(\\) => syncApplication\\.getHotWindow\\(settings\\)/, "hot window panel is a live query through the application boundary");\nassert.match(syncView, /const lastCache = useLiveQuery\\(\\(\\) => syncApplication\\.getLastRemoteCache\\(settings\\)/, "last cache panel is a live query through the application boundary");`,
    "sync view cache assertions",
  ],
]);

replace("scripts/tests/test-v7-ui-data-flow.ts", [
  [
    `// 自动同步不卡界面：空闲期触发（去抖 + requestIdleCallback）、待同步计数独立轻量订阅、\n// 本地归并逐条让出主线程且派生只跑一次。\nassert.match(study, /requestIdleCallback/, "自动同步应等浏览器空闲帧再触发，不撞答题反馈动画");\nassert.match(study, /dbV7\\.changeSets\\.where\\("state"\\)\\.anyOf\\(\\["pending", "blocked"\\]\\)\\.count\\(\\)/, "待同步计数应独立轻量订阅，不与全表统计绑定");\nconst syncOrchestrator = readFileSync(new URL("../../src/lib/sync/sync-v7-orchestrator.ts", import.meta.url), "utf8");`,
    `// 自动同步不卡界面：空闲调度与队列计数均下沉到同步 application/runtime，\n// React 只订阅轻量公开接口；本地归并仍逐条让出主线程且派生只跑一次。\nconst syncRuntimeSource = readFileSync(new URL("../../src/lib/sync/sync-runtime.ts", import.meta.url), "utf8");\nconst syncApplicationSource = readFileSync(new URL("../../src/lib/sync/sync-application.ts", import.meta.url), "utf8");\nassert.match(study, /syncRuntime\\.scheduleAutomaticSync/, "AppShell 应把自动同步调度委托给 runtime");\nassert.match(syncRuntimeSource, /requestIdleCallback/, "runtime 应等浏览器空闲帧再触发自动同步，不撞答题反馈动画");\nassert.match(study, /syncApplication\\.pendingCount\\(\\)/, "待同步计数应通过 application 轻量订阅，不与全表统计绑定");\nassert.match(syncApplicationSource, /changeSets\\.where\\("state"\\)\\.anyOf\\(\\["pending", "blocked"\\]\\)\\.count\\(\\)/, "application 内部保留索引化轻量待同步计数");\nconst syncOrchestrator = readFileSync(new URL("../../src/lib/sync/sync-v7-orchestrator.ts", import.meta.url), "utf8");`,
    "runtime idle and pending assertions",
  ],
  [
    `assert.match(study, /restoreLastRemoteCache[\\s\\S]*setTimeout\\(resolve, 300\\)/, "快捷恢复完成态应留出可见时间");`,
    `assert.match(study, /syncApplication\\.restoreCache[\\s\\S]*setTimeout\\(resolve, 300\\)/, "快捷恢复经 application boundary 完成后仍应留出可见时间");`,
    "quick restore assertion",
  ],
]);

console.log("sync boundary source tests migrated");
