import test from "node:test";
import assert from "node:assert/strict";

import { settle } from "./ledger.mjs";

test("returns the remaining balance after applying entries", () => {
  assert.equal(
    settle(1000, [
      { id: "a", amountMicros: 100 },
      { id: "b", amountMicros: 250 },
    ]),
    650,
  );
});

test("returns the initial balance for an empty entry list", () => {
  assert.equal(settle(42, []), 42);
});

test("deduplicates entries with the same id and amount within one call", () => {
  assert.equal(
    settle(500, [
      { id: "same", amountMicros: 100 },
      { id: "same", amountMicros: 100 },
      { id: "other", amountMicros: 50 },
    ]),
    350,
  );
});

test("rejects conflicting duplicate amounts for the same id", () => {
  assert.throws(
    () =>
      settle(500, [
        { id: "dup", amountMicros: 100 },
        { id: "dup", amountMicros: 200 },
      ]),
    Error,
  );
});

test("rejects an invalid initial balance", () => {
  for (const balance of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "100", undefined]) {
    assert.throws(() => settle(balance, []), Error);
  }
  assert.throws(() => settle(Number.MAX_SAFE_INTEGER + 1, []), Error);
});

test("rejects invalid entry amounts", () => {
  for (const amountMicros of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "100",
    undefined,
    null,
  ]) {
    assert.throws(() => settle(1000, [{ id: "x", amountMicros }]), Error);
  }
});

test("rejects malformed entries", () => {
  for (const entries of [null, undefined, "nope", 42, {}, [null], [42], [[]]]) {
    assert.throws(() => settle(1000, entries), Error);
  }
  assert.throws(() => settle(1000, [{ id: "", amountMicros: 10 }]), Error);
  assert.throws(() => settle(1000, [{ id: 7, amountMicros: 10 }]), Error);
  assert.throws(() => settle(1000, [{ id: "x" }]), Error);
  assert.throws(() => settle(1000, [{ amountMicros: 10 }]), Error);
});

test("rejects an overdraft", () => {
  assert.throws(
    () =>
      settle(100, [
        { id: "a", amountMicros: 60 },
        { id: "b", amountMicros: 60 },
      ]),
    Error,
  );
});

test("allows spending exactly the full balance", () => {
  assert.equal(
    settle(100, [
      { id: "a", amountMicros: 40 },
      { id: "b", amountMicros: 60 },
    ]),
    0,
  );
});

test("does not mutate the entries array or entry objects", () => {
  const entries = [
    { id: "a", amountMicros: 10 },
    { id: "b", amountMicros: 20 },
  ];
  const snapshot = entries.map((entry) => ({ ...entry }));
  const arraySnapshot = [...entries];
  const frozenIds = entries.map((entry) => entry.id);

  Object.freeze(entries[0]);
  Object.freeze(entries[1]);
  Object.freeze(entries);

  assert.equal(settle(100, entries), 70);
  assert.deepEqual(entries, snapshot);
  assert.deepEqual([...entries], arraySnapshot);
  assert.deepEqual(entries.map((entry) => entry.id), frozenIds);
});
