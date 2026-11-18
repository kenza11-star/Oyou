import { expect, it } from "vitest";
import { retryDelayMs } from "@/lib/worker/state";
it("backs off exponentially with bounded jitter and respects server Retry-After", () => {
  expect(retryDelayMs(1, 60000, () => 0)).toBeGreaterThanOrEqual(60000);
  expect(retryDelayMs(5, 0, () => 0.5)).toBeGreaterThan(
    retryDelayMs(1, 0, () => 0.5),
  );
});
