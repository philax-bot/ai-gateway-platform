Implement settle(balanceMicros, entries) in ledger.mjs. Return the remaining integer balance.
All amounts, including the initial balance, must be non-negative safe integers. Entry amount must be positive.
Each entry has a non-empty string id and amountMicros. Deduplicate the same id and amount within one call.
Reject conflicting duplicate amounts, invalid numbers, malformed entries, and any overdraft with an Error.
Do not mutate the entries or their objects. Do not add dependencies. This is a pure local fixture, no IO.
Write ledger.test.mjs with at least seven distinct node:test cases covering these requirements.
Run node --test ledger.test.mjs. Finish only after tests pass. Final reply: PI_HIGRESS_CODE_OK.
