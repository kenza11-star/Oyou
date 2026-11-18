import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

const key = Buffer.alloc(32, 9);

describe("secret encryption", () => {
  it("round-trips plaintext", () => {
    expect(decryptSecret(encryptSecret("ghp_example", key), key)).toBe("ghp_example");
  });

  it("uses a fresh IV for every encryption", () => {
    expect(encryptSecret("same", key)).not.toBe(encryptSecret("same", key));
  });

  it("rejects tampered ciphertext", () => {
    const parts = encryptSecret("token", key).split(".");
    const tampered = Buffer.from(parts[3], "base64");
    tampered[0] ^= 0xff;
    parts[3] = tampered.toString("base64");
    expect(() => decryptSecret(parts.join("."), key)).toThrow();
  });

  it("rejects the wrong key", () => {
    const payload = encryptSecret("token", key);
    expect(() => decryptSecret(payload, Buffer.alloc(32, 1))).toThrow();
  });
});
