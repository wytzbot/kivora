const EXCLUDED_PATTERNS = [
  /movie\s*recap/i, /film\s*recap/i, /\brecap\b/i,
  /movie\s*explained/i, /film\s*explained/i, /ending\s*explained/i,
  /movie\s*summary/i, /film\s*summary/i, /plot\s*summary/i,
  /\breview\b/i, /\breaction\b/i, /\btrailer\b/i, /\bteaser\b/i,
  /scene\s*(compilation|pack|collection)/i, /fan\s*edit/i,
  /\bfull\s*scene\b/i, /\bmovie\s*clip\b/i, /\bfilm\s*clip\b/i,
  /\bclips?\b/i, /\bhighlight(s)?\b/i,
  /\bfree\s*download\b/i, /\bwatch\s*for\s*free\s*download/i,
  /\bcracked\b/i, /\bmod\s*apk\b/i, /telegram/i, /whatsapp\s*group/i
];

function isExcluded(item) {
  const s = item?.snippet || {};
  const text = `${s.title || ""} ${s.description || ""} ${s.channelTitle || ""}`;
  return EXCLUDED_PATTERNS.some((re) => re.test(text));
}

function parseDuration(iso="") {
  const m=String(iso).match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if(!m) return 0;
  return Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0);
}

// Kivora is now a Shorts-first feed. YouTube's API "short" duration bucket is
// broader than Shorts, so the final server filter is <= 180 seconds as well.
// This prevents long-form videos from leaking into the feed.
function isEligibleShort(item) {
  const seconds=Number(item?.contentDetails?.durationSeconds || 0);
  const width=Number(item?.player?.embedWidth || 0);
  const height=Number(item?.player?.embedHeight || 0);
  const publishedAt=String(item?.snippet?.publishedAt || '');
  const uploadedAfterShortsRule=publishedAt && new Date(publishedAt).getTime() >= Date.UTC(2024,9,15);
  // YouTube's current rule for standard channels: square/vertical + <=3 minutes
  // uploaded on/after 2024-10-15 is categorized as a Short. The Data API exposes
  // the player embed dimensions, which lets Kivora reject horizontal videos.
  const squareOrVertical=width>0 && height>0 && width<=height;
  return seconds > 0 && seconds <= 180 && squareOrVertical && uploadedAfterShortsRule && !isExcluded(item);
}

function industryQueries(category) {
  const q = {
    all: ["action shorts #shorts", "movie scene shorts #shorts", "entertainment shorts #shorts"],
    suggested: ["best action shorts #shorts", "viral movie shorts #shorts"],
    new: ["new shorts #shorts", "new action shorts #shorts"],
    hollywood: ["Hollywood shorts #shorts", "Hollywood action shorts #shorts"],
    bollywood: ["Bollywood shorts #shorts", "Hindi movie shorts #shorts"],
    chinese: ["Chinese shorts #shorts", "Chinese action shorts #shorts"],
    korean: ["Korean shorts #shorts", "Korean action shorts #shorts"],
    japanese: ["Japanese shorts #shorts", "Japanese action shorts #shorts"],
    nollywood: ["Nollywood shorts #shorts", "Nigerian movie shorts #shorts"],
    southindian: ["South Indian shorts #shorts", "Tamil Telugu shorts #shorts"],
    thai: ["Thai shorts #shorts", "Thai action shorts #shorts"],
    indonesian: ["Indonesian shorts #shorts", "Indonesian action shorts #shorts"]
  };
  return q[category] || q.all;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=900");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(500).json({ error: "Kivora YouTube is not configured yet. Add YOUTUBE_API_KEY to the server environment variables." });

  const rawQ = Array.isArray(req.query?.q) ? req.query.q[0] : req.query?.q;
  const rawCategory = Array.isArray(req.query?.category) ? req.query.category[0] : req.query?.category;
  const rawVideoId = Array.isArray(req.query?.videoId) ? req.query.videoId[0] : req.query?.videoId;
  const videoId = String(rawVideoId || "").trim().match(/^[A-Za-z0-9_-]{6,}$/)?.[0] || "";
  const q = String(rawQ || "").trim().slice(0, 100);
  const category = String(rawCategory || "all").trim().toLowerCase();

  if (videoId) {
    try {
      const params = new URLSearchParams({part:"snippet,statistics,contentDetails,player",id:videoId,key,maxWidth:"1080",maxHeight:"1920"});
      const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`);
      const data = await response.json();
      if (!response.ok) {
        const reason = data?.error?.errors?.[0]?.reason;
        const message = data?.error?.message || "YouTube video lookup failed.";
        throw new Error(reason ? `${message} (${reason})` : message);
      }
      const item = data?.items?.[0];
      if (!item) return res.status(404).json({error:"Video not found on YouTube."});
      const durationSeconds = parseDuration(item.contentDetails?.duration || "");
      if (!isEligibleShort({snippet:item.snippet,contentDetails:{durationSeconds}})) {
        return res.status(404).json({error:"Kivora only plays eligible Shorts in this feed."});
      }
      return res.status(200).json({
        source:"youtube-data-api-v3",
        items:[{id:item.id,snippet:item.snippet,statistics:item.statistics||{},contentDetails:{duration:item.contentDetails?.duration||"",durationSeconds,caption:item.contentDetails?.caption||"false"}, player:{embedWidth:Number(item.player?.embedWidth||0),embedHeight:Number(item.player?.embedHeight||0)}}],
        nextPageTokens:[]
      });
    } catch (error) {
      return res.status(502).json({error:error?.message || "Kivora could not look up this YouTube Short."});
    }
  }

  const queries = q
    ? [`${q} #shorts -recap -explained -review -reaction -trailer`]
    : industryQueries(category);

  const pageTokens = queries.map((_, i) => {
    const value = Array.isArray(req.query?.[`pageToken${i}`]) ? req.query[`pageToken${i}`][0] : req.query?.[`pageToken${i}`];
    return String(value || "").trim();
  });

  try {
    const results = await Promise.all(queries.map(async (term, queryIndex) => {
      const params = new URLSearchParams({
        part: "snippet", q: term, type: "video", maxResults: "25",
        order: category === "new" ? "date" : "relevance",
        regionCode: "NG", safeSearch: "moderate", videoEmbeddable: "true",
        videoSyndicated: "true", videoDuration: "short", videoCaption: "any", key
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
      .filter((item) => {
        const id=item?.id?.videoId;
        if(!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });

    const ids = rawItems.map(item => item.id.videoId).slice(0, 50);
    let stats = {};
    if (ids.length) {
      const statParams = new URLSearchParams({ part: "statistics,contentDetails,player", id: ids.join(","), key, maxWidth: "1080", maxHeight: "1920" });
      const statResponse = await fetch(`https://www.googleapis.com/youtube/v3/videos?${statParams}`);
      const statData = await statResponse.json();
      if (statResponse.ok) stats = Object.fromEntries((statData.items || []).map(item => [item.id, {statistics:item.statistics||{}, contentDetails:item.contentDetails||{},player:item.player||{}}]));
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
      return { id, snippet: item.snippet, statistics: { viewCount: views, likeCount: likes, commentCount: comments }, contentDetails: { duration: cd.duration || "", durationSeconds, caption: cd.caption || "false" }, player:{embedWidth:Number(stats[id]?.player?.embedWidth||0),embedHeight:Number(stats[id]?.player?.embedHeight||0)}, engagementScore };
    }).filter(isEligibleShort);

    return res.status(200).json({
      source: "youtube-data-api-v3",
      query: q || "Kivora Shorts FYP",
      category,
      shortOnly: true,
      maxDurationSeconds: 180, shortsRule: 'square-or-vertical-and-uploaded-on-or-after-2024-10-15',
      items,
      nextPageTokens: results.map(result => result.nextPageToken || "")
    });
  } catch (error) {
    return res.status(502).json({ error: error?.message || "Kivora could not reach YouTube right now." });
  }
}
