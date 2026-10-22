import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";

const folder = "server/src/schema/migrations";
const expected = readdirSync(folder)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => basename(name, ".ts"))
  .sort();
const actual = readFileSync(`${folder}/ORDER`, "utf8").trim().split("\n");
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(
    "Migration ORDER must list every migration exactly once, sorted by name.",
  );
}

// 官方迁移可以插入较早的时间戳，但已发布的迁移文件不得重命名、删除或改写。
const baseline = process.argv[2];
if (baseline) {
  const changed = execFileSync(
    "git",
    [
      "diff",
      "--name-only",
      "--diff-filter=DMRT",
      baseline,
      "--",
      `${folder}/*.ts`,
    ],
    { encoding: "utf8" },
  ).trim();
  if (changed) {
    throw new Error(
      `Previously published migrations changed relative to ${baseline}:\n${changed}`,
    );
  }
}
console.log(
  `Verified ${actual.length} fork/upstream migrations${baseline ? ` against ${baseline}` : ""}.`,
);
