#!/usr/bin/env node
// Turns a Bastion backup (backup-export, 0594) back into NDJSON.
//
//   BACKUP_ENCRYPTION_KEY=<the base64 key> node scripts/decrypt-backup.mjs bastion-backup-2026-11-01-2100.ndjson.gz.enc
//
// Writes <file without .gz.enc> next to it: line 1 is a header, every other
// line is {"t": "<table>", "r": {…row…}}. Nothing is sent anywhere.

import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { webcrypto } from "node:crypto";

const path = process.argv[2];
const keyB64 = process.env.BACKUP_ENCRYPTION_KEY;
if (!path || !keyB64) {
  console.error("Usage: BACKUP_ENCRYPTION_KEY=<base64 key> node scripts/decrypt-backup.mjs <file.ndjson.gz.enc>");
  process.exit(1);
}

const buf = readFileSync(path);
const magic = buf.subarray(0, 10).toString("utf8");
if (magic !== "BASTIONBK1") {
  console.error(`Not a Bastion backup (header "${magic}").`);
  process.exit(1);
}
const iv = buf.subarray(10, 22);
const cipher = buf.subarray(22);
const key = await webcrypto.subtle.importKey("raw", Buffer.from(keyB64, "base64"), "AES-GCM", false, ["decrypt"]);
let plain;
try {
  plain = Buffer.from(await webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher));
} catch {
  console.error("Decryption failed: wrong key, or the file is damaged.");
  process.exit(1);
}
const out = path.replace(/\.gz\.enc$/, "");
writeFileSync(out, gunzipSync(plain));
const lines = readFileSync(out, "utf8").split("\n").filter(Boolean);
console.log(`Wrote ${out}: ${lines.length - 1} rows. Header: ${lines[0]}`);
