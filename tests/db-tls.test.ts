import { describe, expect, it } from "vitest";
import { buildPoolConfig } from "@/lib/db";

describe("buildPoolConfig", () => {
  it("always verifies the server certificate", () => {
    const cfg = buildPoolConfig("postgres://u:p@host:5432/db");
    expect(cfg.ssl).toMatchObject({ rejectUnauthorized: true });
  });

  it("ignores sslmode values that would disable verification", () => {
    const cfg = buildPoolConfig(
      "postgres://u:p@host:5432/db?sslmode=no-verify",
    );
    expect(String(cfg.connectionString)).not.toContain("sslmode");
    expect(cfg.ssl).toMatchObject({ rejectUnauthorized: true });
  });

  it("passes a supplied CA through", () => {
    const cfg = buildPoolConfig("postgres://u:p@host/db", "PEM");
    expect(cfg.ssl).toMatchObject({ ca: "PEM" });
  });
});

it("prevents connection-string SSL options from overriding verified TLS in the actual pg Client", async () => {
  const { Client } = await import("pg");
  const client = new Client(
    buildPoolConfig("postgres://u:p@host/db?ssl=false"),
  );
  expect((client as any).connectionParameters.ssl).toMatchObject({
    rejectUnauthorized: true,
  });
});
