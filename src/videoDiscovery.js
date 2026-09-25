// Kivora discovery policy: only action-movie-like results are eligible for the organic FYP.
// This is intentionally strict so generic YouTube entertainment (music, vlogs, recaps, etc.)
// does not leak into the movie feed.
const MIN_RECOMMENDATION_RATING = 2.5;
const MIN_CONFIDENT_RATINGS = 5;

const EXCLUDED_PATTERNS = [
  /movie\s*recap/i, /film\s*recap/i, /\brecap\b/i,
  /movie\s*explained/i, /film\s*explained/i, /ending\s*explained/i,
  /movie\s*summary/i, /film\s*summary/i, /plot\s*summary/i,
  /\breview\b/i, /\breaction\b/i, /\btrailer\b/i, /\bteaser\b/i,
  /\bshorts?\b/i, /top\s*\d+/i, /best\s+\d+/i,
  /scene\s*(compilation|pack|collection)/i, /fan\s*edit/i,
  /\bfull\s*scene\b/i, /\bmovie\s*clip\b/i, /\bfilm\s*clip\b/i,
  /\bclips?\b/i, /\bhighlight(s)?\b/i,
  /\bmusic\b/i, /\bmusic\s*video\b/i, /\bsong\b/i, /\blyrics?\b/i,
  /\bafrobeats?\b/i, /\bconcert\b/i, /\bkaraoke\b/i,
  /\bvlog\b/i, /\bday\s*in\s*my\s*life\b/i, /\blifestyle\b/i,
  /\bbillionaire\b/i, /\bluxury\b/i, /\bsupercar(s)?\b/i, /\bcar\s*collection\b/i,
  /\btravel\b/i, /\bcity\s*tour\b/i, /\bfood\b/i, /\bcooking\b/i,
  /\bpodcast\b/i, /\binterview\b/i, /\bnews\b/i, /\bpolitics\b/i,
  /\bgameplay\b/i, /\bgaming\b/i, /\bwalkthrough\b/i, /\btutorial\b/i,
  /\bchallenge\b/i, /\bprank\b/i, /\breaction\b/i,
  /\bepisode\s*\d+\b/i, /\bep\.?\s*\d+\b/i, /\bseason\s*\d+\b/i,
  /full movie\s*\+\s*download/i, /telegram/i, /whatsapp\s*group/i,
  /\bfree\s*download\b/i, /\bwatch\s*for\s*free\s*download/i,
  /\bcracked\b/i, /\bmod\s*apk\b/i, /\bsubscribe\s*\d+\s*channels/i,
  /movie\s*explanation/i, /film\s*explanation/i, /story\s*explained/i, /plot\s*explained/i, /movie\s*breakdown/i, /film\s*breakdown/i, /story\s*recap/i, /movie\s*commentary/i, /movie\s*discussion/i
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
  const shortForMovieFeed = Number(item?.durationSeconds || 0) > 0 && Number(item?.durationSeconds || 0) < 40 * 60;
  return shortForMovieFeed || EXCLUDED_PATTERNS.some(re => re.test(text));
}

export function isLikelyActionMovie(item) {
  if (!item || isLikelySpam(item)) return false;
  const text = `${item?.title || ''} ${item?.description || ''}`;
  const action = ACTION_PATTERNS.some(re => re.test(text));
  const movie = MOVIE_PATTERNS.some(re => re.test(text));
  // Require an explicit action signal, or a strong full-movie/full-film signal.
  // This deliberately rejects generic vlogs, music, celebrity and travel content.
  return action && movie || /\bfull\s*(movie|film)\b/i.test(text);
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
  if (!isLikelyActionMovie(item)) return false;
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
