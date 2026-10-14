const EXCLUDED_PATTERNS = [
  /movie\s*recap/i, /film\s*recap/i, /\brecap\b/i,
  /movie\s*explained/i, /film\s*explained/i, /ending\s*explained/i,
  /movie\s*summary/i, /film\s*summary/i, /plot\s*summary/i,
  /\btrailer\b/i, /\bteaser\b/i,
  /full\s*movie/i, /full\s*film/i, /\bfull\s*episode/i,
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

// Kivora is a vertical-video feed. The Data API does not expose a definitive
// Shorts flag, so we preserve original playback duration and filter by orientation.
function isEligibleShort(item) {
  const seconds=Number(item?.contentDetails?.durationSeconds || 0);
  const width=Number(item?.player?.embedWidth || 0);
  const height=Number(item?.player?.embedHeight || 0);
  // YouTube does not expose a definitive Shorts flag in the Data API.
  // Kivora keeps the vertical/square presentation but does not truncate or cap duration.
  const squareOrVertical=width>0 && height>0 && width<=height;
  return seconds > 0 && squareOrVertical && !isExcluded(item);
}

function industryQueries(category) {
  const q = {
    all: ["shorts #shorts", "viral shorts #shorts", "interesting shorts #shorts"],
    suggested: ["trending shorts #shorts", "viral shorts #shorts"],
    comedy: ["comedy shorts #shorts", "funny shorts #shorts", "standup comedy shorts #shorts"],
    tech: ["tech shorts #shorts", "technology shorts #shorts", "coding tech shorts #shorts"],
    adventure: ["adventure shorts #shorts", "adventure travel shorts #shorts", "exploration shorts #shorts"],
    science: ["science shorts #shorts", "space science shorts #shorts", "physics science shorts #shorts"],
    finance: ["finance shorts #shorts", "personal finance shorts #shorts", "investing finance shorts #shorts"],
    education: ["education shorts #shorts", "learning shorts #shorts", "educational shorts #shorts"],
    gaming: ["gaming shorts #shorts", "game shorts #shorts", "esports shorts #shorts"],
    sports: ["sports shorts #shorts", "football shorts #shorts", "basketball shorts #shorts"],
    food: ["food shorts #shorts", "cooking shorts #shorts", "recipe shorts #shorts"],
    music: ["music shorts #shorts", "music performance shorts #shorts", "dance shorts #shorts"],
    beauty: ["beauty shorts #shorts", "fashion shorts #shorts", "makeup shorts #shorts"],
    new: ["new shorts #shorts", "latest shorts #shorts"]
  };
  return q[category] || q.all;
}

const CATEGORY_TERMS = {
  comedy: /\b(comedy|funny|humor|humour|standup|stand-up|joke|skit|parody|satire)\b/i,
  tech: /\b(tech|technology|coding|programming|software|developer|ai|robot|computer|phone|smartphone|gadget)\b/i,
  adventure: /\b(adventure|explore|exploration|hiking|camping|expedition|survival|travel|safari|climb|climbing)\b/i,
  science: /\b(science|physics|chemistry|biology|space|astronomy|nasa|experiment|quantum|engineering)\b/i,
  finance: /\b(finance|financial|money|investing|investment|stocks?|shares|crypto|bitcoin|forex|budget|saving|savings|business|entrepreneur|economy|economics)\b/i,
  education: /\b(education|educational|learn|learning|lesson|study|school|knowledge|history|language|math|mathematics)\b/i,
  gaming: /\b(gaming|gamer|gameplay|esports|minecraft|fortnite|roblox|playstation|xbox|nintendo|game)\b/i,
  sports: /\b(sport|sports|football|soccer|basketball|tennis|boxing|ufc|athletics|cricket|fifa|nba|nfl)\b/i,
  food: /\b(food|cooking|recipe|chef|kitchen|baking|meal|restaurant|foodie)\b/i,
  music: /\b(music|song|singer|dance|dancing|rapper|rap|guitar|piano|concert|performance)\b/i,
  beauty: /\b(beauty|fashion|makeup|skincare|hair|hairstyle|style|outfit|cosmetic)\b/i
};

const YOUTUBE_CATEGORY_IDS = {
  comedy: ["23"], tech: ["28"], adventure: ["19"], science: ["28"],
  finance: ["22", "27"], education: ["27"], gaming: ["20"], sports: ["17"],
  food: ["26"], music: ["10"], beauty: ["26"],
};

function matchesCategory(item, category) {
  if (!category || ["all", "suggested", "new"].includes(category)) return true;
  const s=item?.snippet || {};
  // Prefer YouTube's own category classification when available. Search snippets
  // don't always include categoryId, so use title/description/channel as fallback.
  const official=String(s.categoryId || item?.categoryId || "");
  const ids=YOUTUBE_CATEGORY_IDS[category] || [];
  if (official && ids.includes(official)) return true;
  const re = CATEGORY_TERMS[category];
  if (!re) return true;
  return re.test(`${s.title || ""} ${s.description || ""} ${s.channelTitle || ""}`);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method==='OPTIONS') return res.status(204).end();
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1800");
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
      if (!isEligibleShort({snippet:item.snippet,contentDetails:{durationSeconds},player:{embedWidth:Number(item.player?.embedWidth||0),embedHeight:Number(item.player?.embedHeight||0)}})) {
        return res.status(404).json({error:"Kivora only plays eligible vertical videos in this feed."});
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

  // One search.list request per feed page is intentional: YouTube search.list
  // costs 100 quota units per call. Category terms are chosen deterministically;
  // the next page token continues the same query without multiplying quota use.
  const categoryTerms = industryQueries(category);
  const queries = [
    q
      ? `${q} #shorts -recap -explained -review -reaction -trailer`
      : categoryTerms[0]
  ];

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
        videoSyndicated: "true", videoCaption: "any", key
      });
      if (pageTokens[queryIndex]) params.set("pageToken", pageTokens[queryIndex]);
      const officialCategoryIds=YOUTUBE_CATEGORY_IDS[category]||[];
      if(officialCategoryIds.length===1) params.set("videoCategoryId",officialCategoryIds[0]);
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
        return matchesCategory(item, category);
      });

    const ids = rawItems.map(item => item.id.videoId).slice(0, 25);
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
      verticalVideoFeed: true,
      shortsRule: 'square-or-vertical; original YouTube playback duration retained',
      items,
      nextPageTokens: results.map(result => result.nextPageToken || "")
    });
  } catch (error) {
    return res.status(502).json({ error: error?.message || "Kivora could not reach YouTube right now." });
  }
}
