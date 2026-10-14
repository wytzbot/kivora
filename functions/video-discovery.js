// Server-side discovery policy. Originality rating is a recommendation signal, not a ban.
const SPAM_PATTERNS = [
  /telegram/i, /whatsapp\s*group/i, /free\s*download/i, /cracked/i,
  /mod\s*apk/i, /subscribe\s*\d+\s*channels/i
];
const MIN_CONFIDENT_RATINGS = 5;
const MIN_RECOMMENDATION_RATING = 2.5;

export function isLikelySpam(video) {
  const text = `${video?.title || video?.snippet?.title || ''} ${video?.description || video?.snippet?.description || ''} ${video?.channelTitle || video?.snippet?.channelTitle || ''}`;
  return SPAM_PATTERNS.some(re => re.test(text));
}

export function effectiveOriginality(video) {
  const countRaw=Number(video?.ratingCount ?? 0);
  const avgRaw=Number(video?.ratingAverage ?? 3);
  const count=Number.isFinite(countRaw) && countRaw >= 0 ? countRaw : 0;
  const avg=Number.isFinite(avgRaw) && avgRaw >= 1 && avgRaw <= 5 ? avgRaw : 3;
  return ((avg*count)+(3*5))/(count+5);
}

export function canRecommend(video) {
  if (isLikelySpam(video)) return false;
  const count=Number(video?.ratingCount||0);
  return count < MIN_CONFIDENT_RATINGS || effectiveOriginality(video) >= MIN_RECOMMENDATION_RATING;
}

export function rankForDiscovery(items=[], limit=20) {
  return [...items].filter(canRecommend).sort((a,b)=>effectiveOriginality(b)-effectiveOriginality(a)).slice(0,limit);
}

export function selectForSearch(items=[], limit=20) {
  return rankForDiscovery(items,limit);
}

export function selectForFYP(items=[], limit=20) {
  return rankForDiscovery(items,limit);
}
