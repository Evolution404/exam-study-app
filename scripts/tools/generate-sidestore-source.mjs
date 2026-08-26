import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const SIDESTORE_SOURCE_URL = "https://learn.980923.xyz/sidestore/source.json";
export const SIDESTORE_IPA_URL = "https://learn.980923.xyz/sidestore/shijuan.ipa";
export const IOS_BUNDLE_ID = "com.evolution404.shijuan";

function readArg(argv, name, fallback = "") {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少参数`);
  return value;
}

export function validateReleaseInput({ version, date, size }) {
  if (!/^\d+(?:\.\d+){1,2}$/.test(version)) {
    throw new Error(`无效 iOS 版本号：${version}；必须是 1.0 或 1.0.1 形式`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error(`无效发布日期：${date}`);
  }
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`无效 IPA 大小：${size}`);
}

export function createSideStoreSource({ version, date, size, notes }) {
  validateReleaseInput({ version, date, size });
  const description = notes.trim() || "与网站同步发布的最新版本。";
  const latest = {
    version,
    date,
    localizedDescription: description,
    downloadURL: SIDESTORE_IPA_URL,
    size,
    minOSVersion: "15.0",
  };

  return {
    name: "拾卷",
    identifier: "com.evolution404.shijuan.source",
    sourceURL: SIDESTORE_SOURCE_URL,
    apps: [
      {
        name: "拾卷",
        bundleIdentifier: IOS_BUNDLE_ID,
        developerName: "Evolution404",
        subtitle: "离线题库与练习工具",
        localizedDescription: "支持 Excel 题库导入、离线练习、复习与多设备同步。",
        iconURL: "https://learn.980923.xyz/icons/app-icon-512.png",
        tintColor: "2E634A",
        permissions: [
          {
            type: "network",
            usageDescription: "用于访问用户配置的同步服务和下载更新。",
          },
        ],
        versions: [latest],
      },
    ],
  };
}

export async function run(argv = process.argv.slice(2)) {
  const ipaPath = path.resolve(readArg(argv, "--ipa", "artifacts/ios/shijuan.ipa"));
  const outputPath = path.resolve(readArg(argv, "--output", "artifacts/ios/sidestore-source.json"));
  const version = readArg(argv, "--version");
  const date = readArg(argv, "--date", new Date().toISOString().slice(0, 10));
  const notesFile = readArg(argv, "--notes-file");
  const notes = notesFile ? await readFile(path.resolve(notesFile), "utf8") : readArg(argv, "--notes", "");
  const { size } = await stat(ipaPath);
  const source = createSideStoreSource({ version, date, size, notes });
  await writeFile(outputPath, `${JSON.stringify(source, null, 2)}\n`, "utf8");
  console.log(`SideStore source 已生成：${outputPath}（${version}，${size} bytes）`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await run();
}
