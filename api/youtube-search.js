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
  /\bchallenge\b/i, /\bprank\b/i,
  /\bepisode\s*\d+\b/i, /\bep\.?\s*\d+\b/i, /\bseason\s*\d+\b/i,
  /full movie\s*\+\s*download/i, /telegram/i, /whatsapp\s*group/i,
  /\bfree\s*download\b/i, /\bwatch\s*for\s*free\s*download/i,
  /\bcracked\b/i, /\bmod\s*apk\b/i, /movie\s*explanation/i, /film\s*explanation/i, /story\s*explained/i, /plot\s*explained/i, /movie\s*breakdown/i, /film\s*breakdown/i, /story\s*recap/i, /movie\s*commentary/i, /movie\s*discussion/i
];

const ACTION_PATTERNS = [
  /\baction\b/i, /\bmartial\s*arts?\b/i, /\bkung\s*f[uú]\b/i,
  /\bwuxia\b/i, /\bkarate\b/i, /\bjiu[- ]?jitsu\b/i, /\bmuay\s*thai\b/i,
  /\bassassin\b/i, /\bhitman\b/i, /\bspy\b/i, /\bwar\b/i,
  /\bwarrior\b/i, /\bfighter\b/i, /\bfighting\b/i, /\bgangster\b/i,
  /\bmafia\b/i, /\bheist\b/i, /\bmercenary\b/i, /\bsuperhero\b/i,
  /\bcomic\s*book\b/i
];
const MOVIE_PATTERNS = [/\bmovie\b/i, /\bfilm\b/i, /\bfull\s*movie\b/i, /\bfull\s*film\b/i, /\bfeature\s*film\b/i, /\bcinema\b/i];

function excluded(item) {
  const s = item?.snippet || {};
  const text = `${s.title || ""} ${s.description || ""} ${s.channelTitle || ""}`;
  return EXCLUDED_PATTERNS.some((re) => re.test(text));
}

function isActionMovie(item) {
  if (!item || excluded(item)) return false;
  const s = item.snippet || {};
  const text = `${s.title || ""} ${s.description || ""}`;
  const action = ACTION_PATTERNS.some(re => re.test(text));
  const movie = MOVIE_PATTERNS.some(re => re.test(text));
  return (action && movie) || /\bfull\s*(movie|film)\b/i.test(text);
}

function industryQueries(category) {
  const q = {
    all: ["action movie full movie -recap -explained -review -reaction -trailer -shorts -episode", "action film full film -recap -explained -review -reaction -trailer -shorts -episode"],
    suggested: ["best action movie full movie -recap -explained -review -reaction -trailer -shorts -episode", "action film full film -recap -explained -review -reaction -trailer -shorts -episode"],
    new: ["new action movie full movie -recap -explained -review -reaction -trailer -shorts -episode", "new action film full film -recap -explained -review -reaction -trailer -shorts -episode"],
    hollywood: ["Hollywood action movie full movie", "Hollywood action film full film"],
    bollywood: ["Bollywood action movie full movie", "Hindi action movie full movie"],
    chinese: ["Chinese action movie full movie", "Chinese martial arts movie full movie"],
    korean: ["Korean action movie full movie", "Korean action film full film"],
    japanese: ["Japanese action movie full movie", "Japanese action film full film"],
    nollywood: ["Nollywood action movie full movie", "Nigerian action movie full movie"],
    southindian: ["South Indian action movie full movie", "Tamil Telugu action movie full movie"],
    thai: ["Thai action movie full movie", "Thai action film full film"],
    indonesian: ["Indonesian action movie full movie", "Indonesian action film full film"]
  };
  return q[category] || q.all;
}

const GLOBAL_INDIAN_TERMS = /\b(bollywood|hindi|tamil|telugu|malayalam|kannada|punjabi|marathi|bengali|indian cinema|indian movie|tollywood|kollywood|mollywood|sandalwood)\b/i;
function parseDuration(iso="") {
  const m=String(iso).match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if(!m) return 0;
  return Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1800");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(500).json({ error: "Kivora YouTube is not configured yet. Add YOUTUBE_API_KEY to the server environment variables." });

  const rawQ = Array.isArray(req.query?.q) ? req.query.q[0] : req.query?.q;
  const rawCategory = Array.isArray(req.query?.category) ? req.query.category[0] : req.query?.category;
  const q = String(rawQ || "").trim().slice(0, 100);
  const category = String(rawCategory || "all").trim().toLowerCase();
  const queries = q ? [`${q} action movie full movie -recap -explained -review -reaction -trailer -teaser -shorts`] : industryQueries(category).map(term => /^(all|suggested|new)$/.test(category) ? `${term} -bollywood -hindi -tamil -telugu -malayalam -kannada -punjabi -marathi -bengali` : term);
  // Each YouTube search query has its own pagination cursor. The client sends
  // pageToken0/pageToken1/... so an infinite feed can continue without
  // restarting the same search from page one.
  const pageTokens = queries.map((_, i) => {
    const value = Array.isArray(req.query?.[`pageToken${i}`]) ? req.query[`pageToken${i}`][0] : req.query?.[`pageToken${i}`];
    return String(value || "").trim();
  });


  try {
    const results = await Promise.all(queries.map(async (term, queryIndex) => {
      const params = new URLSearchParams({
        part: "snippet", q: term, type: "video", maxResults: "15",
        order: category === "new" ? "date" : "relevance",
        regionCode: "US", safeSearch: "moderate", videoEmbeddable: "true", videoSyndicated: "true",
        videoCategoryId: "1", videoDuration: "long", videoCaption: "any", key
      });
      if (pageTokens[queryIndex]) params.set("pageToken", pageTokens[queryIndex]);
      const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
      const data = await response.json();
      if (!response.ok) {
        const reason = data?.error?.errors?.[0]?.reason;
        const message = data?.error?.message || "YouTube Data API request failed.";
        throw new Error(reason ? `${message} (${reason})` : message);
      }
      return { items: data.items || [], nextPageToken: data.nextPageToken || "" };
    }));

    const seen = new Set();
    const rawItems = results.flatMap(result => result.items)
      .filter(isActionMovie)
      .filter((item) => { const id = item.id.videoId; if (seen.has(id)) return false; seen.add(id); return true; });

    const ids = rawItems.map(item => item.id.videoId).slice(0, 50);
    let stats = {};
    if (ids.length) {
      const statParams = new URLSearchParams({ part: "statistics,contentDetails", id: ids.join(","), key });
      const statResponse = await fetch(`https://www.googleapis.com/youtube/v3/videos?${statParams}`);
      const statData = await statResponse.json();
      if (statResponse.ok) stats = Object.fromEntries((statData.items || []).map(item => [item.id, {statistics:item.statistics||{}, contentDetails:item.contentDetails||{}}]));
    }

    const items = rawItems.map(item => {
      const id = item.id.videoId;
      const st = stats[id]?.statistics || {};
      const cd = stats[id]?.contentDetails || {};
      const durationSeconds = parseDuration(cd.duration);
      const views = Number(st.viewCount || 0);
      const likes = Number(st.likeCount || 0);
      const comments = Number(st.commentCount || 0);
      const engagementScore = Math.round((Math.log10(views + 1) * 6 + Math.log10(likes + 1) * 10 + Math.log10(comments + 1) * 4) * 100) / 100;
      return { id, snippet: item.snippet, statistics: { viewCount: views, likeCount: likes, commentCount: comments }, contentDetails: { duration: cd.duration || "", durationSeconds, caption: cd.caption || "false" }, engagementScore };
    }).filter(item => {
      const text = `${item.snippet?.title || ""} ${item.snippet?.description || ""} ${item.snippet?.channelTitle || ""}`;
      const durationOk = Number(item.contentDetails?.durationSeconds || 0) >= 40 * 60;
      const explicitExcluded = EXCLUDED_PATTERNS.some(re => re.test(text));
      const actionSignal = ACTION_PATTERNS.some(re => re.test(text));
      const movieSignal = MOVIE_PATTERNS.some(re => re.test(text));
      const general = /^(all|suggested|new)$/.test(category);
      const wrongIndustry = general && GLOBAL_INDIAN_TERMS.test(text);
      return durationOk && !explicitExcluded && !wrongIndustry && actionSignal && movieSignal;
    });

    return res.status(200).json({
      source: "youtube-data-api-v3",
      query: q || "Kivora action-movie FYP",
      category,
      items,
      nextPageTokens: results.map(result => result.nextPageToken || "")
    });
  } catch (error) {
    return res.status(502).json({ error: error?.message || "Kivora could not reach YouTube right now." });
  }
}
