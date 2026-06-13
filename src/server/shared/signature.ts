/**
 * HMAC signature verification for all webhook providers.
 */
import { createHmac, timingSafeEqual } from "crypto";

/**
 * Verify Slack request signature (v0 scheme).
 * Header: x-slack-signature
 * Format: v0=<hmac-sha256(secret, "v0:{timestamp}:{body}")>
 */
export function verifySlackSignature(
  body: string,
  timestamp: string,
  signature: string,
  secret: string
): boolean {
  // Reject requests older than 5 minutes
  const ts = parseInt(timestamp, 10);
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const sigBasestring = `v0:${timestamp}:${body}`;
  const expected =
    "v0=" + createHmac("sha256", secret).update(sigBasestring, "utf8").digest("hex");

  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Verify GitHub webhook signature (sha256 scheme).
 * Header: x-hub-signature-256
 * Format: sha256=<hmac-sha256(secret, body)>
 */
export function verifyGitHubSignature(
  body: string,
  signature: string,
  secret: string
): boolean {
  const expected =
    "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");

  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Verify Linear webhook signature (plain HMAC-SHA256 hex).
 * Header: linear-signature
 */
export function verifyLinearSignature(
  body: string,
  signature: string,
  secret: string
): boolean {
  if (!secret) return false;
  const computed = createHmac("sha256", secret).update(body).digest("hex");
  return computed === signature;
}

/**
 * Verify Plain webhook signature (plain HMAC-SHA256 hex).
 * Header: plain-request-signature
 */
export function verifyPlainSignature(
  body: string,
  signature: string,
  secret: string
): boolean {
  if (!secret) return false;
  const computed = createHmac("sha256", secret).update(body).digest("hex");
  return computed === signature;
}

/**
 * Verify Stripe webhook signature.
 * Header: stripe-signature
 * Format: t=<timestamp>,v1=<hmac-sha256(secret, "{t}.{body}")>[,v1=<rotated>]
 * The secret is the endpoint signing secret (whsec_…), not the API key.
 */
export function verifyStripeSignature(
  body: string,
  signature: string,
  secret: string
): boolean {
  if (!signature || !secret) return false;

  const parts = signature.split(",").map((p) => p.trim());
  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
  // A secret rotation yields multiple v1 signatures; accept a match on any.
  const candidates = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!timestamp || candidates.length === 0) return false;

  // Reject signatures outside a 5-minute tolerance (replay protection).
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expected);

  return candidates.some((candidate) => {
    const candidateBuf = Buffer.from(candidate);
    if (candidateBuf.length !== expectedBuf.length) return false;
    try {
      return timingSafeEqual(candidateBuf, expectedBuf);
    } catch {
      return false;
    }
  });
}
