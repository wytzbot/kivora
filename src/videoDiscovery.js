// Kivora discovery policy: originality ratings replace hard trusted-channel allowlists.
// Unreviewed creators are not banned; they simply begin with neutral confidence.
const MIN_RECOMMENDATION_RATING = 2.5;
const MIN_CONFIDENT_RATINGS = 5;

const SPAM_PATTERNS = [
  /full movie\s*\+\s*download/i, /telegram/i, /whatsapp\s*group/i,
  /\bfree\s*download\b/i, /\bwatch\s*for\s*free\s*download/i,
  /\bcracked\b/i, /\bmod\s*apk\b/i, /\bsubscribe\s*\d+\s*channels/i
];

export function isLikelySpam(item) {
  const text = `${item?.title || ''} ${item?.description || ''} ${item?.channelTitle || ''}`;
  return SPAM_PATTERNS.some(re => re.test(text));
}

export function effectiveOriginality(itemOrAverage=3, ratingCount=0) {
  const item = itemOrAverage && typeof itemOrAverage === "object" ? itemOrAverage : null;
  const avg = item ? item.ratingAverage : itemOrAverage;
  const countValue = item ? item.ratingCount : ratingCount;
  const prior = 3, priorWeight = 5;
  const count = Number.isFinite(Number(countValue)) && Number(countValue) >= 0 ? Number(countValue) : 0;
  const rating = Number.isFinite(Number(avg)) && Number(avg) >= 1 && Number(avg) <= 5 ? Number(avg) : 3;
  return ((rating * count) + (prior * priorWeight)) / (count + priorWeight);
}

export function canRecommend(item) {
  if (isLikelySpam(item)) return false;
  const count=Number(item?.ratingCount||0);
  if (count < MIN_CONFIDENT_RATINGS) return true;
  return effectiveOriginality(item?.ratingAverage,item?.ratingCount) >= MIN_RECOMMENDATION_RATING;
}

export function rankForDiscovery(items=[]) {
  return [...items].filter(canRecommend).sort((a,b)=>{
    const ar=effectiveOriginality(a.ratingAverage,a.ratingCount), br=effectiveOriginality(b.ratingAverage,b.ratingCount);
    return br-ar;
  });
}
