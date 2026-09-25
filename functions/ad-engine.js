import { isKivoraOwnerEmail } from "./access.js";
// Server-authoritative impression billing/monitoring helpers.
// Kivora charges $1.99 for each 1,500 delivered ad impressions.
// The browser may preview a bill, but the server must recalculate it before payment.
export const IMPRESSION_BLOCK_SIZE = 1500;
export const PRICE_PER_BLOCK_USD = 1.99;
export const MAX_TARGET_IMPRESSIONS = 100000000;

export function calculateBillForUser({ targetImpressions, authenticatedEmail }) {
  const bill = calculateBill({ targetImpressions });
  if (isKivoraOwnerEmail(authenticatedEmail)) {
    return { ...bill, total: 0, ownerBillingBypass: true };
  }
  return { ...bill, ownerBillingBypass: false };
}

function finiteNonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function calculateBill({ targetImpressions }) {
  const impressions = Number(targetImpressions);
  if (!Number.isInteger(impressions) || impressions < IMPRESSION_BLOCK_SIZE || impressions > MAX_TARGET_IMPRESSIONS) {
    throw new Error(`Target impressions must be a whole number from ${IMPRESSION_BLOCK_SIZE.toLocaleString()} to ${MAX_TARGET_IMPRESSIONS.toLocaleString()}.`);
  }
  const blocks = Math.ceil(impressions / IMPRESSION_BLOCK_SIZE);
  const billableImpressions = blocks * IMPRESSION_BLOCK_SIZE;
  const total = Number((blocks * PRICE_PER_BLOCK_USD).toFixed(2));
  return {
    targetImpressions: impressions,
    impressionBlockSize: IMPRESSION_BLOCK_SIZE,
    pricePerBlock: PRICE_PER_BLOCK_USD,
    blocks,
    billableImpressions,
    total
  };
}

export function calculateDeliveredSpend(impressions) {
  const delivered = finiteNonNegative(impressions);
  if (delivered === null) throw new Error('Invalid impression count.');
  return Number(((delivered / IMPRESSION_BLOCK_SIZE) * PRICE_PER_BLOCK_USD).toFixed(4));
}

export function canActivate(campaign, authenticatedEmail = "") {
  const owner = isKivoraOwnerEmail(authenticatedEmail);
  const paymentOkay = owner ? campaign?.paymentStatus !== 'failed' : campaign?.paymentStatus === 'verified';
  return campaign?.preflightStatus === 'passed' &&
    paymentOkay &&
    campaign?.assetStatus === 'verified' &&
    campaign?.moderationStatus === 'approved' &&
    campaign?.status === 'ready';
}

export function updateAdMonitor(campaign, event = {}) {
  const impressions = finiteNonNegative(event.impressions ?? 0);
  const clicks = finiteNonNegative(event.clicks ?? 0);
  if (impressions === null || clicks === null) throw new Error('Invalid monitoring counters.');

  const previousImpressions = finiteNonNegative(campaign?.impressions ?? 0) ?? 0;
  const previousClicks = finiteNonNegative(campaign?.clicks ?? 0) ?? 0;
  const nextImpressions = previousImpressions + impressions;
  const nextClicks = Math.min(previousClicks + clicks, nextImpressions);
  const target = finiteNonNegative(campaign?.targetImpressions ?? 0) ?? 0;
  const spend = calculateDeliveredSpend(nextImpressions);
  const next = {
    impressions: nextImpressions,
    clicks: nextClicks,
    spend,
    lastCheckedAt: new Date().toISOString(),
    ctr: nextImpressions ? Number(((nextClicks / nextImpressions) * 100).toFixed(2)) : 0,
    targetImpressions: target,
    remainingImpressions: Math.max(0, target - nextImpressions),
    budgetRemaining: target ? Number(Math.max(0, (target - nextImpressions) / IMPRESSION_BLOCK_SIZE * PRICE_PER_BLOCK_USD).toFixed(4)) : null
  };
  next.monitorStatus = target && nextImpressions >= target ? 'impression_target_reached' : 'running';
  return next;
}
