import { describe, expect, it } from "vitest";
import { UploadError, validateNewJob } from "@/lib/upload/service";
import { UPLOAD_LIMITS } from "@/lib/upload/limits";

const KEY = "123e4567-e89b-42d3-a456-426614174000";
const good = {
  fileName: "project.zip",
  totalBytes: 1024,
  clientKey: KEY,
  fileSha256: "a".repeat(64),
};

describe("validateNewJob", () => {
  it("accepts a valid request", () => {
    expect(validateNewJob(good)).toEqual(good);
  });

  it("accepts exactly 100 MiB and rejects one byte more", () => {
    expect(
      validateNewJob({ ...good, totalBytes: UPLOAD_LIMITS.webArchiveBytes })
        .totalBytes,
    ).toBe(UPLOAD_LIMITS.webArchiveBytes);
    expect(() =>
      validateNewJob({
        ...good,
        totalBytes: UPLOAD_LIMITS.webArchiveBytes + 1,
      }),
    ).toThrow(UploadError);
  });

  it("rejects zero, negative, fractional, and non-numeric sizes", () => {
    for (const totalBytes of [0, -1, 1.5, "1024", NaN, Infinity]) {
      expect(() => validateNewJob({ ...good, totalBytes })).toThrow(
        UploadError,
      );
    }
  });

  it("rejects non-zip names and path separators", () => {
    expect(() => validateNewJob({ ...good, fileName: "project.tar" })).toThrow(
      /zip/,
    );
    expect(() => validateNewJob({ ...good, fileName: "../evil.zip" })).toThrow(
      /separators/,
    );
    expect(() => validateNewJob({ ...good, fileName: "a\\b.zip" })).toThrow(
      /separators/,
    );
  });

  it("strips control characters from names", () => {
    expect(
      validateNewJob({ ...good, fileName: "pro\u0007ject.zip" }).fileName,
    ).toBe("project.zip");
  });

  it("requires a UUID client key", () => {
    expect(() => validateNewJob({ ...good, clientKey: "not-a-uuid" })).toThrow(
      /UUID/,
    );
    expect(() => validateNewJob({ ...good, clientKey: undefined })).toThrow(
      /UUID/,
    );
  });

  it("rejects a missing body", () => {
    expect(() => validateNewJob(null)).toThrow(UploadError);
  });
});
