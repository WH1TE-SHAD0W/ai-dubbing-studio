// Prints one Markdown table of test coverage for every package that has a
// coverage/coverage-summary.json (made by `pnpm test:coverage`). CI appends it
// to the run summary; locally it just prints. Report only: it never fails.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const rows = [];
for (const group of ["apps", "packages"]) {
  if (!existsSync(group)) continue;
  for (const name of readdirSync(group)) {
    const file = join(group, name, "coverage", "coverage-summary.json");
    if (!existsSync(file)) continue;
    const { total } = JSON.parse(readFileSync(file, "utf8"));
    const pct = (m) => `${total[m].pct}% (${total[m].covered}/${total[m].total})`;
    rows.push(`| \`${group}/${name}\` | ${pct("lines")} | ${pct("branches")} | ${pct("functions")} |`);
  }
}

console.log("### Test coverage\n");
if (rows.length === 0) {
  console.log("No coverage reports found. Run `pnpm test:coverage` first.");
} else {
  console.log("| Package | Lines | Branches | Functions |");
  console.log("|---|---|---|---|");
  for (const row of rows) console.log(row);
  console.log("\nEvery file in each package's `src/` counts, tested or not.");
}
