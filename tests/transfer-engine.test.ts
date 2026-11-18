import { describe, expect, it } from "vitest";
import { AdaptiveConcurrency, HttpError, backoffDelay, isRetryable, runPool, withRetry } from "@/lib/transfer/engine";

describe("backoffDelay", () => {
  it("stays within the exponential cap with full jitter", () => {
    expect(backoffDelay(2, { baseMs: 500, maxMs: 10_000, random: () => 0.5 })).toBe(1000);
    expect(backoffDelay(10, { baseMs: 500, maxMs: 10_000, random: () => 0.999 })).toBeLessThan(10_000);
  });
});

describe("isRetryable", () => {
  it("retries throttling and transient server errors only", () => {
    expect(isRetryable(new HttpError(429))).toBe(true);
    expect(isRetryable(new HttpError(503))).toBe(true);
    expect(isRetryable(new HttpError(404))).toBe(false);
    expect(isRetryable(new TypeError("fetch failed"))).toBe(true);
  });
});

describe("withRetry", () => {
  const noSleep = async () => undefined;

  it("retries transient failures until success", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new HttpError(503);
        return "ok";
      },
      { attempts: 5, baseMs: 1, maxMs: 2, sleep: noSleep, random: () => 0 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry non-retryable errors", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new HttpError(404);
        },
        { attempts: 5, baseMs: 1, maxMs: 2, sleep: noSleep, random: () => 0 },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe("AdaptiveConcurrency", () => {
  it("halves on failure and grows after a success streak, within bounds", () => {
    const c = new AdaptiveConcurrency(8, 2, 16);
    c.onFailure();
    expect(c.limit).toBe(4);
    c.onFailure();
    c.onFailure();
    expect(c.limit).toBe(2);
    for (let i = 0; i < 100; i++) c.onSuccess();
    expect(c.limit).toBeLessThanOrEqual(16);
    expect(c.limit).toBeGreaterThan(2);
  });
});

describe("runPool", () => {
  it("keeps results in input order and never exceeds the limit", async () => {
    const controller = new AdaptiveConcurrency(3, 3, 3);
    let inFlight = 0;
    let peak = 0;
    const out = await runPool([1, 2, 3, 4, 5, 6], controller, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("propagates a worker failure", async () => {
    const controller = new AdaptiveConcurrency(2, 2, 2);
    await expect(
      runPool([1, 2, 3], controller, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("stops starting work after cancellation", async () => {
    const controller = new AdaptiveConcurrency(1, 1, 1);
    const ac = new AbortController();
    let started = 0;
    await expect(
      runPool([1, 2, 3], controller, async () => {
        started++;
        ac.abort();
        return 1;
      }, ac.signal),
    ).rejects.toThrow("cancelled");
    expect(started).toBe(1);
  });
});

it('aborts retry backoff immediately without starting another request',async()=>{
 const abort=new AbortController();
 let calls=0;
 const work=withRetry(async()=>{calls++;throw new HttpError(429,60000);},{attempts:3,baseMs:60000,maxMs:60000,signal:abort.signal});
 setTimeout(()=>abort.abort(),5);
 await expect(work).rejects.toThrow('cancelled');
 expect(calls).toBe(1);
},1000);
