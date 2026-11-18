import { runBatch, runOneJob, verifyWorkerConfiguration } from "./lib/worker/runtime";
import { closeDb } from "./lib/db";
async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help")) {
    console.log(
      "GitHub Manager processor (runs inside GitHub Actions)\nUsage: npm run worker:actions | worker:check | worker:once\n  --batch  drain the queue then exit (default for Actions)\n  --once   process one job\n  --check  verify configuration and schema",
    );
    return;
  }
  if ([...args].some((a) => !["--batch", "--once", "--check"].includes(a))) throw new Error("Unknown worker option; use --help");
  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort());
  process.once("SIGINT", () => stop.abort());
  try {
    await verifyWorkerConfiguration();
    if (args.has("--check")) {
      console.log("Processor configuration and database schema verified");
      return;
    }
    if (args.has("--once")) {
      console.log(`processed=${(await runOneJob(stop.signal)) ? 1 : 0}`);
      return;
    }
    const { processed } = await runBatch(stop.signal);
    console.log(`processed=${processed}`);
  } finally {
    await closeDb();
  }
}
main().catch((error) => {
  console.error("Processor stopped:", error instanceof Error ? error.name : "unknown error");
  process.exitCode = 1;
});
