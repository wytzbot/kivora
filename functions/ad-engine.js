import { isKivoraOwnerEmail } from "./access.js";

// Server-authoritative advertising billing.
// Banner/image placements: $1.99 / 1,500 impressions.
// Video placements: $2.99 / 1,500 impressions.
export const IMPRESSION_BLOCK_SIZE = 1500;
export const BANNER_PRICE_PER_BLOCK_USD = 1.99;
export const VIDEO_PRICE_PER_BLOCK_USD = 2.99;
export const PRICE_PER_BLOCK_USD = BANNER_PRICE_PER_BLOCK_USD; // backwards-compatible export
export const MAX_TARGET_IMPRESSIONS = 100000000;

export function priceForFormat(format) {
  return format === "video" ? VIDEO_PRICE_PER_BLOCK_USD : BANNER_PRICE_PER_BLOCK_USD;
}

export function calculateBillForUser({ targetImpressions, authenticatedEmail, format = "square" }) {
  const bill = calculateBill({ targetImpressions, format });
  if (isKivoraOwnerEmail(authenticatedEmail)) return { ...bill, total: 0, ownerBillingBypass: true };
  return { ...bill, ownerBillingBypass: false };
}

export function calculateBill({ targetImpressions, format = "square" }) {
  const impressions = Number(targetImpressions);
  if (!Number.isInteger(impressions) || impressions < IMPRESSION_BLOCK_SIZE || impressions > MAX_TARGET_IMPRESSIONS) {
    throw new Error(`Target impressions must be a whole number from ${IMPRESSION_BLOCK_SIZE.toLocaleString()} to ${MAX_TARGET_IMPRESSIONS.toLocaleString()}.`);
  }
  const blocks = Math.ceil(impressions / IMPRESSION_BLOCK_SIZE);
  const billableImpressions = blocks * IMPRESSION_BLOCK_SIZE;
  const pricePerBlock = priceForFormat(format);
  const total = Number((blocks * pricePerBlock).toFixed(2));
  return { targetImpressions: impressions, format, impressionBlockSize: IMPRESSION_BLOCK_SIZE, pricePerBlock, blocks, billableImpressions, total };
}

export function calculateDeliveredSpend(impressions, format = "square") {
  const delivered = Number(impressions);
  if (!Number.isFinite(delivered) || delivered < 0) throw new Error("Invalid impression count.");
  return Number(((delivered / IMPRESSION_BLOCK_SIZE) * priceForFormat(format)).toFixed(4));
}

export function canActivate(campaign, authenticatedEmail = "") {
  const owner = isKivoraOwnerEmail(authenticatedEmail);
  const paymentOkay = owner ? campaign?.paymentStatus !== "failed" : campaign?.paymentStatus === "verified";
  return campaign?.preflightStatus === "passed" && paymentOkay && campaign?.assetStatus === "verified" && campaign?.moderationStatus === "approved" && campaign?.status === "ready";
}

export function updateAdMonitor(campaign, event = {}) {
  const impressions = Number(event.impressions ?? 0);
  const clicks = Number(event.clicks ?? 0);
  if (!Number.isFinite(impressions) || impressions < 0 || !Number.isFinite(clicks) || clicks < 0) throw new Error("Invalid monitoring counters.");
  const previousImpressions = Math.max(0, Number(campaign?.impressions ?? 0));
  const previousClicks = Math.max(0, Number(campaign?.clicks ?? 0));
  const nextImpressions = previousImpressions + impressions;
  const nextClicks = Math.min(previousClicks + clicks, nextImpressions);
  const target = Math.max(0, Number(campaign?.targetImpressions ?? 0));
  const format = campaign?.format || "square";
  const spend = calculateDeliveredSpend(nextImpressions, format);
  const next = {
    impressions: nextImpressions,
    clicks: nextClicks,
    spend,
    lastCheckedAt: new Date().toISOString(),
    ctr: nextImpressions ? Number(((nextClicks / nextImpressions) * 100).toFixed(2)) : 0,
    targetImpressions: target,
    remainingImpressions: Math.max(0, target - nextImpressions),
    budgetRemaining: target ? Number(Math.max(0, (target - nextImpressions) / IMPRESSION_BLOCK_SIZE * priceForFormat(format)).toFixed(4)) : null
  };
  next.monitorStatus = target && nextImpressions >= target ? "impression_target_reached" : "running";
  return next;
}
