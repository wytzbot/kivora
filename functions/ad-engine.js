import { isKivoraOwnerEmail } from "./access.js";

// Server-authoritative advertising billing.
// Kivora video placements: $1.00 per 1,500 qualified video impressions.
// A qualified impression requires meaningful viewability; raw iframe loads are not billable.
export const IMPRESSION_BLOCK_SIZE = 1500;
export const VIDEO_PRICE_PER_BLOCK_USD = 1.00;
export const PRICE_PER_BLOCK_USD = VIDEO_PRICE_PER_BLOCK_USD;
export const AD_VIEW_QUALIFICATION_SECONDS = 2;
export const AD_MIN_VIEWABILITY_RATIO = 0.5;
export const AD_FREQUENCY_CAP_PER_SESSION = 1;
export const MAX_TARGET_IMPRESSIONS = 100000000;
// Display/checkout reference rate. Keep this configurable on the server so Flutterwave
// can be charged in the chosen currency after server-side verification.
export const USD_TO_NGN_RATE = Number(process.env.KIVORA_USD_NGN_RATE || 1330);

export function usdToNgn(usd) {
  return Math.round(Number(usd || 0) * USD_TO_NGN_RATE);
}

export function priceForFormat(format) {
  if (format !== "video") throw new Error("Kivora only supports video advertising.");
  return VIDEO_PRICE_PER_BLOCK_USD;
}

export function qualifiesVideoImpression({secondsViewed=0, visibleRatio=0, alreadyCounted=false}={}) {
  return !alreadyCounted &&
    Number(secondsViewed) >= AD_VIEW_QUALIFICATION_SECONDS &&
    Number(visibleRatio) >= AD_MIN_VIEWABILITY_RATIO;
}

export function validatePromotion(campaign={}) {
  const type = campaign.promotionType || "short";
  if (!["short","app"].includes(type)) throw new Error("Invalid promotion type.");
  if (type === "app") {
    if (!/^https?:\/\//i.test(String(campaign.site || "").trim())) throw new Error("App/site promotions require a valid destination URL.");
    if (!String(campaign.destinationName || "").trim()) throw new Error("App/site promotions require a destination name.");
  }
  return { promotionType: type, destinationRequired: type === "app" };
}

export function calculateCampaignPacing({startDate, durationDays=1, targetImpressions=0, deliveredImpressions=0, spend=0, now=new Date()}={}) {
  const days = Math.max(1, Math.min(90, Math.floor(Number(durationDays) || 1)));
  const target = Math.max(0, Number(targetImpressions) || 0);
  const delivered = Math.max(0, Number(deliveredImpressions) || 0);
  const budget = target ? Number((Math.ceil(target / IMPRESSION_BLOCK_SIZE) * VIDEO_PRICE_PER_BLOCK_USD).toFixed(2)) : 0;
  const dailyTarget = target ? Math.ceil(target / days) : 0;
  const start = startDate ? new Date(`${startDate}T00:00:00`) : new Date(now);
  if (Number.isNaN(start.getTime())) throw new Error("Invalid campaign start date.");
  const end = new Date(start); end.setDate(end.getDate() + days - 1);
  const elapsed = Math.max(0, Math.min(days, Math.floor((new Date(now).getTime() - start.getTime()) / 86400000) + 1));
  const expected = Math.min(target, dailyTarget * elapsed);
  const remaining = Math.max(0, target - delivered);
  const remainingBudget = Math.max(0, budget - Number(spend || 0));
  let pacingStatus = "on_track";
  if (target && delivered > expected * 1.1) pacingStatus = "ahead";
  else if (target && delivered < expected * 0.9) pacingStatus = "behind";
  return { startDate: start.toISOString().slice(0,10), endDate: end.toISOString().slice(0,10), durationDays: days, elapsedDays: elapsed, targetImpressions: target, deliveredImpressions: delivered, dailyTargetImpressions: dailyTarget, expectedImpressionsToDate: expected, remainingImpressions: remaining, totalBudget: budget, spend: Number(Number(spend || 0).toFixed(4)), remainingBudget: Number(remainingBudget.toFixed(4)), dailyBudget: Number((budget / days).toFixed(4)), pacingStatus };
}

export function calculateBillForUser({ targetImpressions, authenticatedEmail, format = "video" }) {
  const bill = calculateBill({ targetImpressions, format });
  if (isKivoraOwnerEmail(authenticatedEmail)) return { ...bill, total: 0, ownerBillingBypass: true };
  return { ...bill, ownerBillingBypass: false };
}

export function calculateBill({ targetImpressions, format = "video" }) {
  if (format !== "video") throw new Error("Kivora only supports video advertising.");
  const impressions = Number(targetImpressions);
  if (!Number.isInteger(impressions) || impressions < IMPRESSION_BLOCK_SIZE || impressions > MAX_TARGET_IMPRESSIONS) {
    throw new Error(`Target impressions must be a whole number from ${IMPRESSION_BLOCK_SIZE.toLocaleString()} to ${MAX_TARGET_IMPRESSIONS.toLocaleString()}.`);
  }
  const blocks = Math.ceil(impressions / IMPRESSION_BLOCK_SIZE);
  const billableImpressions = blocks * IMPRESSION_BLOCK_SIZE;
  const pricePerBlock = priceForFormat(format);
  const total = Number((blocks * pricePerBlock).toFixed(2));
  return { targetImpressions: impressions, format, impressionBlockSize: IMPRESSION_BLOCK_SIZE, pricePerBlock, pricePerBlockNgn: usdToNgn(pricePerBlock), blocks, billableImpressions, total, totalNgn: usdToNgn(total), currencyDisplayRate: USD_TO_NGN_RATE };
}

export function calculateDeliveredSpend(impressions, format = "video") {
  const delivered = Number(impressions);
  if (!Number.isFinite(delivered) || delivered < 0) throw new Error("Invalid impression count.");
  return Number(((delivered / IMPRESSION_BLOCK_SIZE) * priceForFormat(format)).toFixed(4));
}

export function canActivate(campaign, authenticatedEmail = "") {
  validatePromotion(campaign);
  const owner = isKivoraOwnerEmail(authenticatedEmail);
  const paymentOkay = owner ? campaign?.paymentStatus !== "failed" : campaign?.paymentStatus === "verified";
  return campaign?.preflightStatus === "passed" && paymentOkay && campaign?.assetStatus === "verified" && campaign?.moderationStatus === "approved" && campaign?.status === "ready";
}

export function updateAdMonitor(campaign, event = {}) {
  const impressions = Number(event.qualifiedImpressions ?? event.impressions ?? 0);
  const clicks = Number(event.clicks ?? 0);
  if (!Number.isFinite(impressions) || impressions < 0 || !Number.isFinite(clicks) || clicks < 0) throw new Error("Invalid monitoring counters.");
  const previousImpressions = Math.max(0, Number(campaign?.impressions ?? 0));
  const previousClicks = Math.max(0, Number(campaign?.clicks ?? 0));
  const nextImpressions = previousImpressions + impressions;
  const nextClicks = Math.min(previousClicks + clicks, nextImpressions);
  const format = campaign?.format || "video";
  if (format !== "video") throw new Error("Only video campaigns can be delivered.");
  const target = Math.max(0, Number(campaign?.targetImpressions ?? 0));
  const billableImpressions = target ? Math.min(nextImpressions, target) : nextImpressions;
  const spend = calculateDeliveredSpend(billableImpressions, format);
  const next = {
    impressions: nextImpressions,
    qualifiedImpressions: nextImpressions,
    billableImpressions,
    clicks: nextClicks,
    spend,
    lastCheckedAt: new Date().toISOString(),
    ctr: nextImpressions ? Number(((nextClicks / nextImpressions) * 100).toFixed(2)) : 0,
    targetImpressions: target,
    remainingImpressions: Math.max(0, target - nextImpressions),
    budgetRemaining: target ? Number(Math.max(0, (target - nextImpressions) / IMPRESSION_BLOCK_SIZE * priceForFormat(format)).toFixed(4)) : null,
    spendPer1500: priceForFormat(format),
    qualifiedImpressionRate: priceForFormat(format) / IMPRESSION_BLOCK_SIZE
  };
  next.monitorStatus = target && nextImpressions >= target ? "impression_target_reached" : "running";
  if (campaign?.startDate || campaign?.durationDays) {
    next.pacing = calculateCampaignPacing({startDate:campaign.startDate, durationDays:campaign.durationDays, targetImpressions:target, deliveredImpressions:billableImpressions, spend, now:event.now ? new Date(event.now) : new Date()});
  }
  return next;
}
