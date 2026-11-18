import { expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { extractZip } from "@/lib/github/upload";
function duplicateName() {
  const zip = zipSync(
    { "a.txt": strToU8("one"), "b.txt": strToU8("two") },
    { level: 0 },
  );
  for (let i = 0; i < zip.length - 5; i++)
    if (String.fromCharCode(...zip.subarray(i, i + 5)) === "b.txt") zip[i] = 97;
  return zip;
}
it("rejects duplicate names instead of silently keeping one file", () =>
  expect(() => extractZip(duplicateName())).toThrow(/duplicate/i));
it("rejects corrupted stored file CRC", () => {
  const zip = zipSync({ "a.txt": strToU8("unique-data") }, { level: 0 });
  const at = Buffer.from(zip).indexOf("unique-data");
  zip[at] ^= 1;
  expect(() => extractZip(zip)).toThrow(/CRC|checksum/i);
});
it("rejects unsafe directory entries even when empty", () =>
  expect(() => extractZip(zipSync({ "../": new Uint8Array() }))).toThrow(
    /unsafe/i,
  ));
it("supports thousands of project files and keeps bytes exact", () => {
  const entries: Record<string, Uint8Array> = {};
  for (let i = 0; i < 3000; i++)
    entries[`src/part-${i}.ts`] = strToU8(`export const n=${i};`);
  entries[".github/workflows/build.yaml"] = strToU8("on: push\n");
  entries["assets/image.png"] = new Uint8Array([137, 80, 78, 71, 0, 255, 20]);
  const files = extractZip(zipSync(entries));
  expect(files).toHaveLength(3002);
  expect(files.find((f) => f.path === "assets/image.png")?.data).toEqual(
    entries["assets/image.png"],
  );
});
