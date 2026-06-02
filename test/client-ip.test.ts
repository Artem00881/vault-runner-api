import { test, expect } from "bun:test";
import { extractClientIp } from "../src/common/client-ip";

test("prefers CF-Connecting-IP (trustworthy behind the mTLS edge)", () => {
  expect(
    extractClientIp({
      headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" },
      ip: "127.0.0.1",
    }),
  ).toBe("203.0.113.7");
});

test("falls back to the first X-Forwarded-For hop", () => {
  expect(
    extractClientIp({ headers: { "x-forwarded-for": "198.51.100.1, 10.0.0.1" }, ip: "127.0.0.1" }),
  ).toBe("198.51.100.1");
});

test("falls back to req.ip when there are no proxy headers", () => {
  expect(extractClientIp({ headers: {}, ip: "192.0.2.5" })).toBe("192.0.2.5");
});

test("handles array X-Forwarded-For and missing ip", () => {
  expect(
    extractClientIp({
      headers: { "x-forwarded-for": ["198.51.100.9, 10.0.0.2"] },
      socket: { remoteAddress: "10.1.1.1" },
    }),
  ).toBe("198.51.100.9");
  expect(extractClientIp({ headers: {}, socket: { remoteAddress: "10.1.1.1" } })).toBe("10.1.1.1");
});
