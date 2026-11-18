import { expect, it, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
const state = vi.hoisted(() => ({
  claimed: false,
  commit: vi
    .fn()
    .mockResolvedValue({
      commitSha: "a".repeat(40),
      commitUrl: "https://github.com/a/b/commit/" + "a".repeat(40),
      added: 1,
      updated: 0,
      unchanged: 0,
    }),
}));
vi.mock("@/lib/db", () => ({
  db: () => ({
    query: async (sql: string) => {
      if (sql.includes("pending_action") && sql.includes("returning")) {
        if (state.claimed) return { rows: [] };
        state.claimed = true;
        return { rows: [{ id: 1 }] };
      }
      if (sql.includes("insert into app.push_operations"))
        return { rows: [{ id: "123e4567-e89b-42d3-a456-426614174000" }] };
      return { rows: [] };
    },
  }),
}));
vi.mock("@/lib/telegram/state", () => ({
  getUserState: async () => ({
    repoId: 42,
    repoFullName: "a/b",
    repoBranch: "develop",
    pendingAction: "await_zip",
    pendingActive: true,
  }),
  setPending: async () => {},
}));
vi.mock("@/lib/telegram/context", () => ({
  withGithub: async (_: unknown, __: unknown, fn: any) => fn("token", "user"),
}));
vi.mock("@/lib/github/repos", () => ({
  assertRepoAccessible: async () => ({
    id: 42,
    fullName: "a/b",
    defaultBranch: "main",
  }),
}));
vi.mock("@/lib/github/branches", () => ({
  getBranch: async (_: unknown, __: unknown, branch: string) => branch,
}));
vi.mock("@/lib/activity", () => ({ logActivity: async () => {} }));
vi.mock("@/lib/telegram/api", () => ({
  getFilePath: async () => "/file",
  downloadTelegramFile: async () => zipSync({ "file.txt": strToU8("hello") }),
}));
vi.mock("@/lib/github/upload", async (original) => ({
  ...(await original<typeof import("@/lib/github/upload")>()),
  commitFiles: state.commit,
}));
import { handleZipUpload } from "@/lib/telegram/documents";
it("atomically consumes one direct upload and commits to the selected branch", async () => {
  const ctx = {
    telegramUserId: 1,
    chatId: 1,
    env: { telegramBotToken: "test" },
    reply: vi.fn(),
  };
  await Promise.all([
    handleZipUpload(ctx as any, {
      file_id: "1",
      file_name: "p.zip",
      file_size: 100,
    }),
    handleZipUpload(ctx as any, {
      file_id: "2",
      file_name: "p.zip",
      file_size: 100,
    }),
  ]);
  expect(state.commit).toHaveBeenCalledTimes(1);
  expect(state.commit.mock.calls[0][2]).toBe("develop");
});
