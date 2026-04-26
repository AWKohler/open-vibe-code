import { config } from "dotenv";
import { runPersistentSandboxSmokeTest } from "../lib/vercel-sandbox";

config({ path: ".env.local" });

async function main() {
  const projectId = process.argv[2] ?? "local-smoke-test";
  const result = await runPersistentSandboxSmokeTest(projectId);

  if (result.stderr.trim()) {
    console.error(result.stderr.trim());
  }

  console.log(result.stdout.trim());

  if (result.exitCode !== 0) {
    process.exitCode = result.exitCode;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
