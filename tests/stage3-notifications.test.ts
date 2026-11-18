import { expect, it } from "vitest";
import { notificationText } from "@/lib/worker/notifications";
it("does not claim committed files while blobs are still being uploaded", () => {
  const text = notificationText({
    status: "processing",
    processing_stage: "uploading_blobs",
    repo_full_name: "a/b",
    branch: "main",
    total_bytes: "10",
    bytes_received: "10",
    chunk_count: 1,
    chunks_done: 1,
    files_total: 3,
    files_extracted: 3,
    files_processed: 2,
    files_added: 1,
    files_updated: 1,
    files_unchanged: 1,
    files_failed: 0,
    github_bytes_uploaded: "5",
    github_bytes_total: "10",
  } as any);
  expect(text).toContain("Files processed: 2 / 3");
  expect(text).toContain("Not committed");
  expect(text).not.toContain("UPLOAD COMPLETED");
});
it("requires remote confirmation before rendering success", () => {
  expect(
    notificationText({ status: "completed", github_confirmed_at: null } as any),
  ).not.toContain("UPLOAD COMPLETED");
});
