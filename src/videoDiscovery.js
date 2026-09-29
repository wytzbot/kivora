// Kivora discovery policy: only eligible short-form videos are allowed into the organic FYP.
// The server performs the authoritative duration filter; this client-side check is a second guard.
const MIN_RECOMMENDATION_RATING = 2.5;
const MIN_CONFIDENT_RATINGS = 5;

const EXCLUDED_PATTERNS = [
  /movie\s*recap/i, /film\s*recap/i, /\brecap\b/i,
  /movie\s*explained/i, /film\s*explained/i, /ending\s*explained/i,
  /movie\s*summary/i, /film\s*summary/i, /plot\s*summary/i,
  /\btrailer\b/i, /\bteaser\b/i, /full\s*movie/i, /full\s*film/i,
  /\bfree\s*download\b/i, /\bcracked\b/i, /\bmod\s*apk\b/i,
  /telegram/i, /whatsapp\s*group/i
];

const ACTION_PATTERNS = [
  /\baction\b/i, /\bmartial\s*arts?\b/i, /\bkung\s*f[uú]\b/i,
  /\bwuxia\b/i, /\bkarate\b/i, /\bjiu[- ]?jitsu\b/i, /\bmuay\s*thai\b/i,
  /\bassassin\b/i, /\bhitman\b/i, /\bspy\b/i, /\bwar\b/i,
  /\bwarrior\b/i, /\bfighter\b/i, /\bfighting\b/i, /\bguns?\b/i,
  /\bgangster\b/i, /\bmafia\b/i, /\bheist\b/i, /\bmercenary\b/i,
  /\bsuperhero\b/i, /\bcomic\s*book\b/i
];

const MOVIE_PATTERNS = [
  /\bmovie\b/i, /\bfilm\b/i, /\bfull\s*movie\b/i, /\bfull\s*film\b/i,
  /\bfeature\s*film\b/i, /\bcinema\b/i
];

export function isLikelySpam(item) {
  const text = `${item?.title || ''} ${item?.description || ''} ${item?.channelTitle || ''}`;
  const seconds = Number(item?.durationSeconds || 0);
  const blocked = [
    /telegram/i, /whatsapp\s*group/i, /free\s*download/i, /cracked/i,
    /mod\s*apk/i, /pornography/i, /\bxxx\b/i
  ].some(re => re.test(text));
  return blocked || !(seconds > 0 && seconds <= 180);
}

export function isEligibleShort(item) {
  if (!item) return false;
  const seconds = Number(item?.durationSeconds || 0);
  const width = Number(item?.embedWidth || item?.player?.embedWidth || 0);
  const height = Number(item?.embedHeight || item?.player?.embedHeight || 0);
  const publishedAt = String(item?.publishedAt || item?.snippet?.publishedAt || '');
  const uploadedAfterShortsRule = publishedAt && new Date(publishedAt).getTime() >= Date.UTC(2024,9,15);
  return seconds > 0 && seconds <= 180 && width > 0 && height > 0 && width <= height && uploadedAfterShortsRule && !isLikelySpam(item);
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
  if (!isEligibleShort(item)) return false;
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
