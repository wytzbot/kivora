const EXCLUDED_PATTERNS = [
  /movie\s*recap/i, /film\s*recap/i, /recap/i,
  /movie\s*explained/i, /film\s*explained/i, /ending\s*explained/i,
  /movie\s*summary/i, /film\s*summary/i, /plot\s*summary/i,
  /review/i, /reaction/i, /trailer/i, /teaser/i,
  /shorts?/i, /top\s*\d+/i, /best\s+\d+/i,
  /scene\s*(compilation|pack|collection)/i, /fan\s*edit/i,
  /telegram/i, /whatsapp\s*group/i, /free\s*download/i,
  /cracked/i, /mod\s*apk/i
];

function excluded(item) {
  const s = item?.snippet || {};
  const text = `${s.title || ""} ${s.description || ""} ${s.channelTitle || ""}`;
  return EXCLUDED_PATTERNS.some((re) => re.test(text));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(500).json({ error: "Kivora YouTube is not configured yet. Add YOUTUBE_API_KEY to the server environment variables." });

  const rawQ = Array.isArray(req.query?.q) ? req.query.q[0] : req.query?.q;
  const rawCategory = Array.isArray(req.query?.category) ? req.query.category[0] : req.query?.category;
  const q = String(rawQ || "").trim().slice(0, 100);
  const category = String(rawCategory || "all").trim().toLowerCase();
  const categoryQueries = {
    all: ["action movie full film", "Hollywood action film", "Bollywood action film", "Chinese action film", "Korean action film"],
    suggested: ["action movie full film", "best action film"],
    new: ["new action movie full film", "new action film"],
    hollywood: ["Hollywood action movie full film", "Hollywood action film"],
    bollywood: ["Bollywood action movie full film", "Hindi action film"],
    chinese: ["Chinese action movie full film", "Chinese martial arts action film"],
    korean: ["Korean action movie full film", "Korean action film"],
    japanese: ["Japanese action movie full film", "Japanese action film"],
    nollywood: ["Nollywood action movie full film", "Nigerian action film"],
    southindian: ["South Indian action movie full film", "Tamil Telugu action film"],
    thai: ["Thai action movie full film", "Thai action film"],
    indonesian: ["Indonesian action movie full film", "Indonesian action film"]
  };
  const queries = q ? [`${q} action movie`] : (categoryQueries[category] || categoryQueries.all);

  try {
    const results = await Promise.all(queries.map(async (term) => {
      const params = new URLSearchParams({
        part: "snippet", q: term, type: "video", maxResults: "10", order: category === "new" ? "date" : "relevance",
        regionCode: "NG", safeSearch: "moderate", videoEmbeddable: "true", videoSyndicated: "true", key
      });
      const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
      const data = await response.json();
      if (!response.ok) {
        const reason = data?.error?.errors?.[0]?.reason;
        const message = data?.error?.message || "YouTube Data API request failed.";
        throw new Error(reason ? `${message} (${reason})` : message);
      }
      return data.items || [];
    }));

    const seen = new Set();
    const rawItems = results.flat()
      .filter((item) => item?.id?.videoId && !excluded(item))
      .filter((item) => { const id = item.id.videoId; if (seen.has(id)) return false; seen.add(id); return true; });

    // Fetch public YouTube engagement statistics so Kivora can build a suggested feed.
    // This is still server-side; the API key never reaches the browser.
    const ids = rawItems.map(item => item.id.videoId).slice(0, 50);
    let stats = {};
    if (ids.length) {
      const statParams = new URLSearchParams({ part: "statistics", id: ids.join(","), key });
      const statResponse = await fetch(`https://www.googleapis.com/youtube/v3/videos?${statParams}`);
      const statData = await statResponse.json();
      if (statResponse.ok) {
        stats = Object.fromEntries((statData.items || []).map(item => [item.id, item.statistics || {}]));
      }
    }

    const items = rawItems.map(item => {
      const id = item.id.videoId;
      const st = stats[id] || {};
      const views = Number(st.viewCount || 0);
      const likes = Number(st.likeCount || 0);
      const comments = Number(st.commentCount || 0);
      // Log-scaled engagement prevents huge channels from completely dominating.
      const engagementScore = Math.round((Math.log10(views + 1) * 6 + Math.log10(likes + 1) * 10 + Math.log10(comments + 1) * 4) * 100) / 100;
      return { id, snippet: item.snippet, statistics: { viewCount: views, likeCount: likes, commentCount: comments }, engagementScore };
    });

    return res.status(200).json({ source: "youtube-data-api-v3", query: q || "FYP discovery", items });
  } catch (error) {
    return res.status(502).json({ error: error?.message || "Kivora could not reach YouTube right now." });
  }
}
