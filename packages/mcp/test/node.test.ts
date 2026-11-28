import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const src = fileURLToPath(new URL("../src/", import.meta.url));
const modules = readdirSync(src, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .map((file) => pathToFileURL(`${src}${file}`).href);

// The server runs this package on Node straight from source, without a build step.
it("loads every module on Node without a build step", () => {
  expect(modules.length).toBeGreaterThan(5);
  const script = `for (const m of ${JSON.stringify(modules)}) await import(m);`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" });
});
