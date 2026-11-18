// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  render,
  fireEvent,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react";
import Uploader from "@/app/upload/uploader";
const payload = new Uint8Array(8 * 1024 * 1024 + 3);
payload[0] = 80;
payload[1] = 75;
const file = {
  name: "p.zip",
  size: payload.length,
  lastModified: 100,
  arrayBuffer: async () => payload.slice().buffer,
  slice: (start: number, end: number) => ({
    arrayBuffer: async () => payload.slice(start, end).buffer,
  }),
};
let job: any,
  keys: string[],
  hold: boolean,
  uploads: number[],
  aborted: number,
  cancelCalls: number,
  failComplete: boolean,
  expired: boolean;
const scope = {
  telegramUserId: 1,
  repoId: 42,
  repoFullName: "a/b",
  branch: "main",
};
const pending = new Set<FakeXHR>();
class FakeXHR {
  status = 200;
  timeout = 0;
  upload = { onprogress: null as any };
  onload: any;
  onerror: any;
  onabort: any;
  ontimeout: any;
  url = "";
  headers: Record<string, string> = {};
  open(method: string, url: string) {
    expect(method).toBe("PUT");
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  getResponseHeader() {
    return null;
  }
  send(body: ArrayBuffer) {
    expect(this.headers).toEqual({
      "content-type": "application/octet-stream",
    });
    const index = Number(this.url.split("/").pop());
    uploads.push(index);
    expect(
      Buffer.from(body).equals(
        Buffer.from(
          payload.subarray(
            index * 8 * 1024 * 1024,
            (index + 1) * 8 * 1024 * 1024,
          ),
        ),
      ),
    ).toBe(true);
    pending.add(this);
    this.upload.onprogress?.({
      lengthComputable: true,
      loaded: body.byteLength,
    });
    if (!hold || index === 0)
      queueMicrotask(() => {
        if (pending.delete(this)) this.onload?.();
      });
  }
  abort() {
    if (pending.delete(this)) {
      aborted++;
      this.onabort?.();
    }
  }
}
const summary = () => ({
  ...job,
  bytesVerified: job.chunks
    .filter((c: any) => c.status === "verified")
    .reduce((n: number, c: any) => n + c.size, 0),
  missing: job.chunks
    .filter((c: any) => c.status !== "verified")
    .map((c: any) => c.index),
});
beforeEach(() => {
  keys = [];
  job = null;
  hold = false;
  uploads = [];
  aborted = 0;
  cancelCalls = 0;
  failComplete = false;
  expired = false;
  pending.clear();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/upload#t=test-token");
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, opts: any) => {
      if (opts.signal?.aborted) throw new Error("cancelled");
      const reply = (data: any, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (path.endsWith("/context")) return reply(scope);
      if (path === "/api/upload/jobs") {
        const b = JSON.parse(opts.body);
        keys.push(b.clientKey);
        expect(b.fileSha256).toBe(
          createHash("sha256").update(payload).digest("hex"),
        );
        if (expired) {
          expired = false;
          return reply({ error: "expired" }, 410);
        }
        if (!job || job.key !== b.clientKey)
          job = {
            key: b.clientKey,
            id: "123e4567-e89b-42d3-a456-426614174000",
            status: "created",
            fileName: b.fileName,
            totalBytes: b.totalBytes,
            repoFullName: scope.repoFullName,
            branch: scope.branch,
            chunkSize: 8 * 1024 * 1024,
            chunkCount: 2,
            chunks: [
              { index: 0, size: 8 * 1024 * 1024, status: "pending" },
              { index: 1, size: 3, status: "pending" },
            ],
          };
        return reply(summary());
      }
      const m = /chunks\/(\d+)\/(sign|complete)/.exec(path);
      if (m) {
        const index = Number(m[1]);
        if (m[2] === "sign")
          return reply(
            job.chunks[index].status === "verified"
              ? { verified: true }
              : {
                  verified: false,
                  attemptId: String(index),
                  url: "https://storage.test/" + index,
                },
          );
        job.chunks[index].status = "verified";
        if (failComplete) {
          failComplete = false;
          return reply({ error: "temporary" }, 503);
        }
        return reply({ verified: true });
      }
      if (path.endsWith("/ready")) {
        expect(job.chunks.every((c: any) => c.status === "verified")).toBe(
          true,
        );
        job.status = "uploaded";
        return reply(summary());
      }
      if (path.endsWith("/process")) return reply(summary());
      if (path.endsWith("/cancel")) {
        job.status = "cancelled";
        cancelCalls++;
        return reply(summary());
      }
      throw new Error("Unexpected request " + path);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const choose = async (container: HTMLElement) => {
  await waitFor(() =>
    expect(container.querySelector("input")?.disabled).toBe(false),
  );
  fireEvent.change(container.querySelector("input")!, {
    target: { files: [file] },
  });
};

it("uploads actual chunks and retries completion without sending bytes again", async () => {
  failComplete = true;
  const view = render(<Uploader />);
  await choose(view.container);
  await screen.findByText(
    "Mengirim ke GitHub…",
    {},
    { timeout: 10000 },
  );
  expect(uploads.sort()).toEqual([0, 1]);
  expect(window.location.hash).toBe("");
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
    "100",
  );
});
it("reload resumes verified chunks using the same scoped file identity", async () => {
  hold = true;
  const view = render(<Uploader />);
  await choose(view.container);
  await waitFor(() => expect(job?.chunks[0].status).toBe("verified"));
  const originalKey = keys[0];
  view.unmount();
  expect(aborted).toBeGreaterThan(0);
  hold = false;
  uploads = [];
  const resumed = render(<Uploader />);
  await choose(resumed.container);
  await screen.findByText(
    "Mengirim ke GitHub…",
    {},
    { timeout: 10000 },
  );
  expect(keys[1]).toBe(originalKey);
  expect(uploads).toEqual([1]);
});
it("cancel aborts active transfers and calls the current job endpoint", async () => {
  hold = true;
  const view = render(<Uploader />);
  await choose(view.container);
  await waitFor(() => expect(pending.size).toBeGreaterThan(0));
  fireEvent.click(screen.getByRole("button", { name: "Batal" }));
  await screen.findByText("Unggahan dibatalkan.");
  expect(aborted).toBeGreaterThan(0);
  expect(cancelCalls).toBe(1);
  expect(pending.size).toBe(0);
});
it("replaces an expired local job key with a new key before uploading", async () => {
  expired = true;
  const view = render(<Uploader />);
  await choose(view.container);
  await screen.findByText(
    "Mengirim ke GitHub…",
    {},
    { timeout: 10000 },
  );
  expect(keys.length).toBe(2);
  expect(keys[0]).not.toBe(keys[1]);
});
