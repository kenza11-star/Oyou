/* Browser regression checks with controlled API/Storage responses, no production credentials.
 * Start npm run dev separately, then npm run test:browser.
 */
const { chromium } = require("playwright");
const { zipSync } = require("fflate");
const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: "chromium",
    ...(process.env.CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
      : {}),
    args: ["--no-sandbox"],
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const scope = {
      telegramUserId: 1,
      repoId: 42,
      repoFullName: "owner/repo",
      branch: "main",
    };
    const payload = Buffer.from(
      zipSync({ "source.ts": new Uint8Array(17 * 1024 * 1024) }, { level: 0 }),
    );
    const file = {
      name: "project.zip",
      mimeType: "application/zip",
      buffer: payload,
    };
    const chunkSize = 8 * 1024 * 1024;
    let job = null,
      clientKey = null,
      paths = new Map(),
      putIndexes = [],
      hold = false,
      expired = false,
      cancelled = 0,
      completionCalls = 0;
    const summary = () => ({
      ...job,
      missing: job.chunks
        .filter((c) => c.status !== "verified")
        .map((c) => c.index),
      bytesVerified: job.chunks
        .filter((c) => c.status === "verified")
        .reduce((s, c) => s + c.size, 0),
    });
    await page.route("**/api/upload/**", async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname;
      const respond = (status, body) => route.fulfill({ status, json: body });
      if (path.endsWith("/context")) return respond(200, scope);
      if (path === "/api/upload/jobs") {
        const b = req.postDataJSON();
        assert.equal(
          b.fileSha256,
          createHash("sha256").update(payload).digest("hex"),
        );
        if (expired && clientKey === b.clientKey) {
          expired = false;
          return respond(410, { error: "expired" });
        }
        if (!job || clientKey !== b.clientKey) {
          clientKey = b.clientKey;
          job = {
            id: randomUUID(),
            status: "created",
            fileName: b.fileName,
            repoFullName: scope.repoFullName,
            branch: scope.branch,
            totalBytes: b.totalBytes,
            chunkSize,
            chunkCount: Math.ceil(b.totalBytes / chunkSize),
            chunks: Array.from(
              { length: Math.ceil(b.totalBytes / chunkSize) },
              (_, index) => ({
                index,
                size: Math.min(chunkSize, b.totalBytes - index * chunkSize),
                status: "pending",
              }),
            ),
          };
        }
        return respond(200, summary());
      }
      const match = /chunks\/(\d+)\/(sign|complete)/.exec(path);
      if (match) {
        const index = Number(match[1]);
        if (match[2] === "sign") {
          if (job.chunks[index].status === "verified")
            return respond(200, { verified: true });
          const attemptId = randomUUID();
          paths.set(attemptId, index);
          return respond(200, {
            verified: false,
            attemptId,
            url: `http://127.0.0.1:3000/mock-storage/${attemptId}`,
          });
        }
        const b = req.postDataJSON();
        assert.equal(paths.get(b.attemptId), index);
        completionCalls++;
        // Simulate a successful verification whose response is lost once.
        job.chunks[index].status = "verified";
        if (completionCalls === 1) return respond(503, { error: "temporary" });
        return respond(200, { verified: true });
      }
      if (path.endsWith("/process")) return respond(200, summary());
      if (path.endsWith("/ready")) {
        assert(job.chunks.every((c) => c.status === "verified"));
        job.status = "uploaded";
        return respond(200, summary());
      }
      if (path.endsWith("/cancel")) {
        job.status = "cancelled";
        cancelled++;
        return respond(200, summary());
      }
      return respond(404, { error: "unknown" });
    });
    await page.route("**/mock-storage/**", async (route) => {
      const id = new URL(route.request().url()).pathname.split("/").pop();
      const index = paths.get(id);
      putIndexes.push(index);
      assert.equal(route.request().method(), "PUT");
      assert.equal(route.request().headers()["x-upsert"], undefined);
      assert.equal(route.request().headers()["authorization"], undefined);
      const data = route.request().postDataBuffer();
      assert(
        data.equals(
          payload.subarray(index * chunkSize, (index + 1) * chunkSize),
        ),
      );
      while (hold && index > 0) await delay(20);
      await route.fulfill({ status: 200, json: { Key: "ok" } }).catch(() => {});
    });
    const url = process.env.UPLOADER_URL || "http://127.0.0.1:3000/upload";
    await page.goto(url + "#t=test-token");
    await page.locator("input[type=file]").waitFor();
    hold = true;
    await page.locator("input[type=file]").setInputFiles(file);
    await page.waitForFunction(
      () => document.body.textContent.includes("1 / 3"),
      { timeout: 20000 },
    );
    assert.equal(new URL(page.url()).hash, "");
    await page.reload();
    hold = false;
    putIndexes = [];
    await page.locator("input[type=file]").setInputFiles(file);
    await page
      .getByText("Mengirim ke GitHub…", { exact: true })
      .waitFor({ timeout: 30000 });
    assert(
      !putIndexes.includes(0),
      "verified chunk must not be uploaded after reload",
    );
    console.log(
      "PASS reload resume, checksum identity, direct PUT, real byte payloads, completion retry",
    );
    // Fresh job and cancellation of active browser requests.
    job = null;
    hold = true;
    await page.locator("input[type=file]").setInputFiles(file);
    await page.getByRole("button", { name: "Batal", exact: true }).waitFor();
    await page.waitForFunction(() =>
      document.body.textContent.includes("Mengunggah…"),
    );
    await page.getByRole("button", { name: "Batal", exact: true }).click();
    await page.getByText("Unggahan dibatalkan.", { exact: true }).waitFor();
    assert.equal(cancelled, 1);
    hold = false;
    console.log(
      "PASS cancel aborts browser work and calls owned job cancellation",
    );
    // Existing key now expired: uploader must obtain a fresh key and retry once.
    expired = true;
    await page.getByRole("button", { name: "Coba lagi", exact: true }).click();
    await page
      .getByText("Mengirim ke GitHub…", { exact: true })
      .waitFor({ timeout: 30000 });
    console.log("PASS expired job safely creates a fresh upload");
    await context.close();
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
