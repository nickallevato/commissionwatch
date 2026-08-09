import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  verifyPassword,
  DEFAULT_SCRYPT_PARAMS,
  TEST_SCRYPT_PARAMS,
} from "../src/services/auth/password";

describe("operator password hashing", () => {
  it("defaults to the parameters the spec fixed", () => {
    assert.deepEqual(DEFAULT_SCRYPT_PARAMS, { N: 65536, r: 8, p: 1, keylen: 64 });
  });

  it("round-trips a password", async () => {
    const stored = await hashPassword("correct horse battery staple", TEST_SCRYPT_PARAMS);
    assert.equal(await verifyPassword("correct horse battery staple", stored), true);
  });

  it("rejects the wrong password", async () => {
    const stored = await hashPassword("correct horse battery staple", TEST_SCRYPT_PARAMS);
    assert.equal(await verifyPassword("Correct horse battery staple", stored), false);
  });

  it("carries its parameters in the stored string", async () => {
    const stored = await hashPassword("hunter2hunter2", TEST_SCRYPT_PARAMS);
    const [scheme, n, r, p, salt, hash] = stored.split("$");

    assert.equal(scheme, "scrypt");
    assert.equal(Number(n), TEST_SCRYPT_PARAMS.N);
    assert.equal(Number(r), TEST_SCRYPT_PARAMS.r);
    assert.equal(Number(p), TEST_SCRYPT_PARAMS.p);
    assert.ok(Buffer.from(salt, "base64").length >= 16);
    assert.equal(Buffer.from(hash, "base64").length, TEST_SCRYPT_PARAMS.keylen);
  });

  it("salts, so the same password hashes differently every time", async () => {
    const a = await hashPassword("same password", TEST_SCRYPT_PARAMS);
    const b = await hashPassword("same password", TEST_SCRYPT_PARAMS);
    assert.notEqual(a, b);
    assert.equal(await verifyPassword("same password", a), true);
    assert.equal(await verifyPassword("same password", b), true);
  });

  it("verifies a hash stored at different parameters than the current default", async () => {
    // The upgrade path: raising the cost must not lock out existing operators.
    const legacy = await hashPassword("legacy password", { N: 2048, r: 8, p: 1, keylen: 64 });
    assert.equal(await verifyPassword("legacy password", legacy), true);
  });

  it("returns false rather than throwing on a malformed stored value", async () => {
    assert.equal(await verifyPassword("anything", "not-a-hash"), false);
    assert.equal(await verifyPassword("anything", "bcrypt$1$2$3$4"), false);
    assert.equal(await verifyPassword("anything", ""), false);
  });

  it("can hash at the production parameters without blowing maxmem", async () => {
    // N=2^16, r=8 needs 64 MiB; node defaults maxmem to 32 MiB and throws
    // without an explicit override. This test is the regression guard for that.
    const stored = await hashPassword("production cost", DEFAULT_SCRYPT_PARAMS);
    assert.equal(await verifyPassword("production cost", stored), true);
  });
});
