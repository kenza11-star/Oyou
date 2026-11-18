import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { extractZip } from "@/lib/github/upload";
import { readCentralDirectory } from "@/lib/upload/zip-entries";

function setExternalAttrs(
  zip: Uint8Array,
  name: string,
  attrs: number,
): Uint8Array {
  const out = zip.slice();
  const view = new DataView(out.buffer);
  for (let i = 0; i + 46 <= out.length; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const len = view.getUint16(i + 28, true);
    const entryName = new TextDecoder().decode(
      out.subarray(i + 46, i + 46 + len),
    );
    if (entryName === name) {
      view.setUint32(i + 38, attrs, true);
      return out;
    }
  }
  throw new Error("entry not found in test archive");
}

describe("ZIP handling", () => {
  it("keeps binary bytes and dotfiles exact", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 13, 10]);
    const zip = zipSync({
      "assets/logo.png": png,
      ".gitignore": strToU8("node_modules\n"),
      ".github/workflows/build.yml": strToU8("on: push\n"),
    });
    const files = Object.fromEntries(
      extractZip(zip).map((f) => [f.path, f.data]),
    );
    expect(Array.from(files["assets/logo.png"])).toEqual(Array.from(png));
    expect(new TextDecoder().decode(files[".gitignore"])).toBe(
      "node_modules\n",
    );
    expect(files[".github/workflows/build.yml"]).toBeDefined();
  });

  it("keeps an empty file", () => {
    const files = extractZip(
      zipSync({ "empty.txt": new Uint8Array(0), "a.txt": strToU8("x") }),
    );
    expect(files.find((f) => f.path === "empty.txt")?.data.length).toBe(0);
  });

  it("rejects a symbolic link entry instead of writing it as a file", () => {
    const zip = zipSync({ link: strToU8("target"), "real.txt": strToU8("x") });
    const linked = setExternalAttrs(zip, "link", (0o120777 << 16) >>> 0);
    expect(
      readCentralDirectory(linked).find((e) => e.name === "link")?.isSymlink,
    ).toBe(true);
    expect(() => extractZip(linked)).toThrow(/Symbolic links/);
  });

  it("rejects traversal and .git entries", () => {
    expect(() => extractZip(zipSync({ "../x.txt": strToU8("x") }))).toThrow(
      /Unsafe ZIP entry/,
    );
    expect(() => extractZip(zipSync({ ".git/config": strToU8("x") }))).toThrow(
      /Unsafe ZIP entry/,
    );
  });

  it("rejects archives over the requested byte limit", () => {
    const zip = zipSync({ "a.txt": strToU8("x") });
    expect(() => extractZip(zip, 4)).toThrow(/larger than/);
  });

  it("rejects non-ZIP bytes", () => {
    expect(() => extractZip(strToU8("definitely not a zip file"))).toThrow();
  });
});

it("preserves YAML, JSON, source, Android and workflow files without filtering extensions", () => {
  const contents = {
    "settings.yaml": strToU8("enabled: true\n"),
    "settings.yml": strToU8("version: 1\n"),
    "package.json": strToU8('{"name":"app"}'),
    "src/main.ts": strToU8("export const x = 1;"),
    "app/build.gradle.kts": strToU8(
      'plugins { id("com.android.application") }',
    ),
    "app/src/main/AndroidManifest.xml": strToU8("<manifest/>"),
    gradlew: strToU8("#!/bin/sh\n"),
    ".github/workflows/build.yaml": strToU8("on: push\n"),
    ".env.example": strToU8("API_URL=\n"),
  };
  const files = Object.fromEntries(
    extractZip(zipSync(contents)).map((f) => [f.path, f.data]),
  );
  expect(Object.keys(files).sort()).toEqual(Object.keys(contents).sort());
  for (const [name, data] of Object.entries(contents))
    expect(files[name]).toEqual(data);
});
