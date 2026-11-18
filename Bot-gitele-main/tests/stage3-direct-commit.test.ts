import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ head: "a".repeat(40), unconfirmed: false }));
vi.mock("@/lib/github/client", async (original) => ({
  ...(await original<typeof import("@/lib/github/client")>()),
  github: async (_: string, path: string, init?: { method?: string }) => {
    if (path.includes("/git/refs/heads/") && !init?.method)
      throw new Error("GET requires singular git/ref endpoint");
    if (path.includes("/git/ref/heads/"))
      return {
        object: { sha: state.unconfirmed ? "f".repeat(40) : state.head },
      };
    if (path.includes("/compare/")) return { status: "diverged" };
    if (path.includes("/git/commits/") && !init?.method)
      return { tree: { sha: "b".repeat(40) } };
    if (path.includes("/git/trees/") && !init?.method)
      return { truncated: false, tree: [] };
    if (path.endsWith("/git/blobs")) return { sha: "c".repeat(40) };
    if (path.endsWith("/git/trees")) return { sha: "d".repeat(40) };
    if (path.endsWith("/git/commits"))
      return {
        sha: "e".repeat(40),
        html_url: "https://github.com/a/b/commit/" + "e".repeat(40),
      };
    throw new Error(path);
  },
  githubRaw: async () => {
    state.head = "e".repeat(40);
    return Response.json({ ok: true });
  },
}));
import { commitFiles } from "@/lib/github/upload";
it("confirms direct Telegram commits using the real read-ref endpoint before success", async () => {
  state.head = "a".repeat(40);
  state.unconfirmed = false;
  const result = await commitFiles(
    "test",
    "a/b",
    "main",
    [{ path: "x.txt", data: new Uint8Array([1]) }],
    "Update",
  );
  expect(result.commitSha).toBe("e".repeat(40));
});
