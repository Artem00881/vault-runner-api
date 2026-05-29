import { test, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { generateSeedChain, verifyChainLink } from "../src/fairness/seed-chain";

test("each seed hashes to its predecessor, back to the commit", () => {
  const chain = generateSeedChain(1000);
  expect(chain.length).toBe(1000);
  for (let k = 1; k < chain.length; k++) {
    expect(verifyChainLink(chain[k], chain[k - 1])).toBe(true);
  }
});

test("a tampered seed breaks the link", () => {
  const chain = generateSeedChain(100);
  const fake = randomBytes(32).toString("hex");
  expect(verifyChainLink(fake, chain[0])).toBe(false);
});

test("chains are unique per generation", () => {
  expect(generateSeedChain(10)[0]).not.toBe(generateSeedChain(10)[0]);
});
