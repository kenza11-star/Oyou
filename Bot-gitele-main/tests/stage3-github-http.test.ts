import { afterEach, expect, it, vi } from "vitest";
import { githubRaw, GithubRateLimitError } from "@/lib/github/client";
afterEach(() => vi.unstubAllGlobals());
it("recognizes secondary rate limits and carries Retry-After", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { message: "You have exceeded a secondary rate limit" },
          { status: 403, headers: { "retry-after": "17" } },
        ),
      ),
  );
  await expect(githubRaw("private", "/user")).rejects.toMatchObject({
    retryAfterMs: 17000,
  });
});
it("never sends user credentials to a non-GitHub API URL", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(githubRaw("private", "https://attacker.test/x")).rejects.toThrow(
    /origin|URL/i,
  );
  expect(fetcher).not.toHaveBeenCalled();
});
