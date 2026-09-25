import React,{useEffect,useRef,useState} from "react";
import {createRoot} from "react-dom/client";
import "./styles.css";
import { isLikelySpam, effectiveOriginality, canRecommend } from "./videoDiscovery";
import {
 auth,db,startAnonymousSession,signInWithGoogle,finishGoogleRedirect,onAuthStateChanged,
 enablePushNotifications,toggleLike,saveVideo,logOut,getProEntitlement
} from "./firebase";
import {doc,getDoc,setDoc,serverTimestamp,runTransaction,collection,getDocs,query as fsQuery,limit,where} from "firebase/firestore";
import { isKivoraOwner } from "./access.js";

const EMPTY_VIDEOS=[];
// Display-only FX reference for showing Naira equivalents beside USD prices.
// Actual payment should use the server-side verified Flutterwave amount.
const USD_TO_NGN_DISPLAY_RATE = 1330;
function usdToNgn(usd){ return Math.round(Number(usd||0) * USD_TO_NGN_DISPLAY_RATE); }
function moneyUsdNgn(usd){ return `$${Number(usd||0).toFixed(2)} (≈ ₦${usdToNgn(usd).toLocaleString()})`; }

function normalizeVideo(item){
 const id=item?.id?.videoId || item?.id || item?.videoId;
 if(!id) return null;
 const s=item?.snippet || item;
 return {
  id,
  title:s?.title || "Untitled video",
  lang:s?.categoryLabel || s?.defaultLanguage || "YouTube",
  desc:s?.description || "Video discovered through YouTube.",
  thumb:s?.thumbnails?.high?.url || s?.thumbnails?.medium?.url || s?.thumbnails?.default?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  channelTitle:s?.channelTitle || "",
  publishedAt:s?.publishedAt || "",
  viewCount:Number(item?.statistics?.viewCount||0),
  youtubeLikeCount:Number(item?.statistics?.likeCount||0),
  commentCount:Number(item?.statistics?.commentCount||0),
  durationSeconds:Number(item?.contentDetails?.durationSeconds||0),
  hasCaptions:String(item?.contentDetails?.caption||"false")==="true",
  engagementScore:Number(item?.engagementScore||0)
 };
}

async function fetchKivoraVideos(query="", category="all", pageTokens=[]){
 const params=new URLSearchParams();
 if(query) params.set("q",query);
 if(category && category!=="all") params.set("category",category);
 (Array.isArray(pageTokens)?pageTokens:[]).forEach((token,index)=>{if(token) params.set(`pageToken${index}`,token)});
 const qs=params.toString();
 const url=`/api/youtube-search${qs?`?${qs}`:""}`;
 const res=await fetch(url,{headers:{accept:"application/json"}});
 let data={};
 try{data=await res.json()}catch{}
 if(!res.ok) throw new Error(data?.error || `Video discovery failed (${res.status})`);
 const items=Array.isArray(data?.items)?data.items.map(normalizeVideo).filter(Boolean):[];
 return {items,source:data?.source||"youtube",nextPageTokens:Array.isArray(data?.nextPageTokens)?data.nextPageTokens:[]};
}

async function fetchKivoraVideoById(videoId){
 const id=String(videoId||"").trim();
 if(!id) return null;
 const res=await fetch(`/api/youtube-search?videoId=${encodeURIComponent(id)}`,{headers:{accept:"application/json"}});
 let data={}; try{data=await res.json()}catch{}
 if(!res.ok) throw new Error(data?.error||`Video lookup failed (${res.status})`);
 return Array.isArray(data?.items)&&data.items[0]?normalizeVideo(data.items[0]):null;
}

async function rateVideo(videoId,uid,value){
 if(!uid) throw new Error("A Google account is required to rate originality.");
 const rating=Math.trunc(Number(value));
 if(!Number.isInteger(rating)||rating<1||rating>5) throw new Error("Rating must be between 1 and 5.");
 const videoRef=doc(db,"videos",videoId);
 const ratingRef=doc(db,"videos",videoId,"ratings",uid);
 return runTransaction(db,async tx=>{
  const existing=await tx.get(ratingRef);
  if(existing.exists()) throw new Error("You have already rated this video.");
  const snap=await tx.get(videoRef);
  if(!snap.exists()) throw new Error("This video is not available for rating.");
  const d=snap.data()||{};
  const sum=Number(d.ratingSum||0);
  const count=Number(d.ratingCount||0);
  if(!Number.isFinite(sum)||!Number.isFinite(count)||sum<0||count<0) throw new Error("The rating data is invalid.");
  const nextSum=sum+rating;
  const nextCount=count+1;
  const average=nextSum/nextCount;
  tx.set(ratingRef,{uid,rating,createdAt:serverTimestamp()});
  tx.update(videoRef,{ratingSum:nextSum,ratingCount:nextCount,ratingAverage:average,ratingUpdatedAt:serverTimestamp()});
  return {average,count:nextCount,changed:true};
 });
}

function App(){
 const initialWatchId=useRef(new URLSearchParams(window.location.search).get("watch")||"");
 const [tab,setTab]=useState(()=>initialWatchId.current?"watch":"home"),[premium,setPremium]=useState(false),[menu,setMenu]=useState(false);
 const [user,setUser]=useState(auth.currentUser),[busy,setBusy]=useState(false),[notice,setNotice]=useState("");
 const [notifyPrompt,setNotifyPrompt]=useState(true);
 const [pendingNewVideos,setPendingNewVideos]=useState(0),[ratings,setRatings]=useState({}),[query,setQuery]=useState(""),[category,setCategory]=useState("all"),[videos,setVideos]=useState(EMPTY_VIDEOS),[pageTokens,setPageTokens]=useState([]),[hasMore,setHasMore]=useState(true),[loadingMore,setLoadingMore]=useState(false),[sponsored,setSponsored]=useState([]),[videoLoading,setVideoLoading]=useState(true),[videoError,setVideoError]=useState(""),[theme,setTheme]=useState(()=>localStorage.getItem("kivora-theme")||"system"),[installPrompt,setInstallPrompt]=useState(null),[selectedVideo,setSelectedVideo]=useState(null);
 const feedSentinelRef=useRef(null);
 const signedIn=!!user&&!user.isAnonymous;
 const owner=isKivoraOwner(user);
 useEffect(()=>{
   const id=initialWatchId.current;
   if(!id) return;
   let live=true;
   fetchKivoraVideoById(id).then(v=>{if(live&&v){setSelectedVideo(v);setTab("watch");}}).catch(e=>{if(live)setNotice(e?.message||"This video could not be loaded.")});
   return()=>{live=false};
 },[]);

 useEffect(()=>{
   const apply=()=>{const dark=theme==="dark"||(theme==="system"&&window.matchMedia?.("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.theme=dark?"dark":"light";document.documentElement.style.colorScheme=dark?"dark":"light";};
   apply(); localStorage.setItem("kivora-theme",theme);
   const mq=window.matchMedia?.("(prefers-color-scheme: dark)"); const fn=()=>theme==="system"&&apply(); mq?.addEventListener?.("change",fn); return()=>mq?.removeEventListener?.("change",fn);
 },[theme]);
 useEffect(()=>{const fn=e=>{e.preventDefault();setInstallPrompt(e)};window.addEventListener("beforeinstallprompt",fn);return()=>window.removeEventListener("beforeinstallprompt",fn)},[]);
 useEffect(()=>{if(owner)setPremium(true)},[owner]);
 useEffect(()=>{let live=true;getProEntitlement(user).then(v=>{if(live)setPremium(v)});return()=>{live=false}},[user]);
 useEffect(()=>{
   const off=onAuthStateChanged(auth,u=>setUser(u));
   // Give guests an anonymous Kivora session so Like/Save are immediately interactive.
   // Google sign-in can later link this session and keep the account history.
   if(!auth.currentUser) startAnonymousSession().catch(()=>{});
   finishGoogleRedirect().then(r=>r?.user&&setNotice("Google sign-in complete.")).catch(e=>setNotice(authMessage(e)));
   return off;
 },[]);
 useEffect(()=>{
   if(user && !user.isAnonymous) getDoc(doc(db,"users",user.uid)).then(s=>{const d=s.data()||{};setPendingNewVideos(Number(d.pendingNewVideos||0));}).catch(()=>{});
 },[user]);
 useEffect(()=>{ if(notice){const t=setTimeout(()=>setNotice(""),4200);return()=>clearTimeout(t)} },[notice]);
 useEffect(()=>{
   let live=true;
   (async()=>{
     try{
       const snap=await getDocs(fsQuery(collection(db,"campaigns"),where("status","==","ready"),limit(12)));
       if(live)setSponsored(snap.docs.map(d=>({id:d.id,...d.data()})).filter(c=>c.moderationStatus==="approved"&&c.assetStatus==="verified"&&c.paymentStatus==="verified"&&Number(c.remainingImpressions??1)>0));
     }catch{if(live)setSponsored([])}
   })();
   return()=>{live=false};
 },[]);

 useEffect(()=>{
   let live=true;
   const missing=videos.filter(v=>!Object.prototype.hasOwnProperty.call(ratings,v.id));
   if(!missing.length)return()=>{live=false};
   Promise.all(missing.map(v=>getDoc(doc(db,"videos",v.id)).catch(()=>null))).then(snaps=>{if(!live)return;const next={};snaps.forEach((s,i)=>{const d=s?.data()||{};next[missing[i].id]={ratingAverage:Number(d.ratingAverage||3),ratingCount:Number(d.ratingCount||0)}});setRatings(prev=>({...prev,...next}))});
   return()=>{live=false};
 },[videos,ratings]);

 useEffect(()=>{
   const q=query.trim();
   const timer=setTimeout(async()=>{
    setVideoLoading(true);setVideoError("");setPageTokens([]);setHasMore(true);setVideos([]);
    try{
      const result=await fetchKivoraVideos(q,category,[]);
      setVideos(result.items);
      setPageTokens(result.nextPageTokens);
      setHasMore(result.nextPageTokens.some(Boolean));
      if(!result.items.length&&!result.nextPageTokens.some(Boolean))setVideoError(q?"No YouTube videos matched that search.":"YouTube returned no eligible videos for Kivora right now.");
    }catch(e){setVideoError(e?.message||"Video discovery could not be completed.");setVideos([]);setPageTokens([]);setHasMore(false);}
    finally{setVideoLoading(false);}
   },q?450:50);
   return()=>clearTimeout(timer);
 },[query,category]);

 async function loadMoreVideos(){
   if(videoLoading||loadingMore||!hasMore)return;
   setLoadingMore(true);setVideoError("");
   try{
     const result=await fetchKivoraVideos(query.trim(),category,pageTokens);
     setVideos(prev=>{
       const seen=new Set(prev.map(v=>v.id));
       return [...prev,...result.items.filter(v=>!seen.has(v.id))];
     });
     setPageTokens(result.nextPageTokens);
     setHasMore(result.nextPageTokens.some(Boolean));
   }catch(e){setVideoError(e?.message||"More videos could not be loaded right now.");}
   finally{setLoadingMore(false);}
 }

 useEffect(()=>{
   const node=feedSentinelRef.current;
   if(!node)return;
   const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))loadMoreVideos()},{rootMargin:"900px 0px"});
   observer.observe(node);
   return()=>observer.disconnect();
 },[videoLoading,loadingMore,hasMore,pageTokens,query,category]);

 async function guest(){setBusy(true);try{await startAnonymousSession();setNotice("You can start watching immediately.");}catch(e){setNotice(authMessage(e))}finally{setBusy(false)}}
 async function google(){setBusy(true);try{const r=await signInWithGoogle();if(r)setNotice("Google sign-in complete.");}catch(e){setNotice(authMessage(e))}finally{setBusy(false)}}
 async function notifications(){
   if(busy)return;
   if(!user || user.isAnonymous){setNotice("Connect Google before enabling notifications so Kivora can associate alerts with your account."); return;}
   try{
    const token=await enablePushNotifications();
    setNotifyPrompt(false);
    if(user&&!user.isAnonymous&&token) await setDoc(doc(db,"users",user.uid),{notificationSettings:{enabled:true,notifyEvery:10,updatedAt:serverTimestamp()}},{merge:true});
    setNotice("Notifications are enabled. Kivora will group new-video alerts after 10 new eligible videos.");
   }catch(e){setNotice(e.message)}
 }
 const go=(t,{history=true}={})=>{
   setTab(t);
   if(t!=="watch")setSelectedVideo(null);
   setMenu(false);
   if(history){
     const nextHash=t==="home"?"#home":`#${t}`;
     window.history.pushState({kivora:true,tab:t},"",nextHash);
   }
   window.scrollTo({top:0,behavior:"auto"});
 };
 const openVideo=video=>{
   setSelectedVideo(video);
   setTab("watch");
   setMenu(false);
   window.history.pushState({kivora:true,tab:"watch",videoId:video.id},"",`?watch=${encodeURIComponent(video.id)}`);
   window.scrollTo({top:0,behavior:"auto"});
 };

 useEffect(()=>{
   const base=window.location.origin;
   const canonical=tab==="watch"&&selectedVideo?`${base}/?watch=${encodeURIComponent(selectedVideo.id)}`:`${base}/`;
   const title=tab==="watch"&&selectedVideo?`${selectedVideo.title} | Kivora`:category!=="all"?`${category[0].toUpperCase()+category.slice(1)} Action Movies | Kivora`:"Kivora | Action Movies & Long-Form Entertainment";
   const description=tab==="watch"&&selectedVideo?`Watch ${selectedVideo.title} on Kivora through the official YouTube player. Discover more long-form action movies and related videos.`:"Kivora is an action-movie discovery platform for long-form entertainment, with Hollywood, Chinese, Korean, Japanese, Nollywood and other action-movie categories.";
   document.title=title;
   const setMeta=(selector,attrs,content)=>{let el=document.head.querySelector(selector);if(!el){el=document.createElement("meta");Object.entries(attrs).forEach(([k,v])=>el.setAttribute(k,v));document.head.appendChild(el);}el.setAttribute("content",content)};
   setMeta('meta[name="description"]',{name:"description"},description);
   setMeta('meta[property="og:title"]',{property:"og:title"},title);
   setMeta('meta[property="og:description"]',{property:"og:description"},description);
   setMeta('meta[property="og:type"]',{property:"og:type"},tab==="watch"?"video.other":"website");
   setMeta('meta[property="og:url"]',{property:"og:url"},canonical);
   setMeta('meta[property="og:site_name"]',{property:"og:site_name"},"Kivora");
   if(tab==="watch"&&selectedVideo?.thumb)setMeta('meta[property="og:image"]',{property:"og:image"},selectedVideo.thumb);
   setMeta('meta[name="twitter:card"]',{name:"twitter:card"},"summary_large_image");
   setMeta('meta[name="twitter:title"]',{name:"twitter:title"},title);
   setMeta('meta[name="twitter:description"]',{name:"twitter:description"},description);
   let link=document.head.querySelector('link[rel="canonical"]');if(!link){link=document.createElement("link");link.rel="canonical";document.head.appendChild(link)}link.href=canonical;
   let schema=document.getElementById("kivora-seo-schema");if(!schema){schema=document.createElement("script");schema.id="kivora-seo-schema";schema.type="application/ld+json";document.head.appendChild(schema)}
   const baseGraph=[
    {"@type":"WebSite","@id":`${base}/#website`,url:base+"/",name:"Kivora",description:"Action-movie and long-form entertainment discovery platform."},
    {"@type":"Organization","@id":`${base}/#organization`,name:"Kivora",url:base+"/"}
   ];
   if(tab==="watch"&&selectedVideo){
     const seconds=Math.max(0,Number(selectedVideo.durationSeconds||0));
     const iso=seconds?`PT${Math.floor(seconds/3600)}H${Math.floor((seconds%3600)/60)}M${seconds%60}S`:undefined;
     baseGraph.push({"@type":"VideoObject",name:selectedVideo.title,description:selectedVideo.desc||description,thumbnailUrl:[selectedVideo.thumb],uploadDate:selectedVideo.publishedAt||undefined,duration:iso,embedUrl:`https://www.youtube-nocookie.com/embed/${selectedVideo.id}`,creator:selectedVideo.channelTitle?{"@type":"Organization",name:selectedVideo.channelTitle}:undefined,interactionStatistic:{"@type":"InteractionCounter",interactionType:{"@type":"WatchAction"},userInteractionCount:Number(selectedVideo.viewCount||0)}});
   }
   schema.textContent=JSON.stringify({"@context":"https://schema.org", "@graph":baseGraph});
 },[tab,selectedVideo,category]);
 useEffect(()=>{
   const onPop=async()=>{
     const params=new URLSearchParams(window.location.search);
     const watchId=params.get("watch");
     const state=window.history.state||{};
     if(watchId){
       const found=videos.find(v=>v.id===watchId);
       if(found){setSelectedVideo(found);setTab("watch");return;}
       try{const fetched=await fetchKivoraVideoById(watchId); if(fetched){setSelectedVideo(fetched);setTab("watch");return;}}catch{}
     }
     setSelectedVideo(null);
     setTab(state?.kivora?.tab || (state?.tab && ["home","watchlist","history","account","premium","ads","faqs","about","privacy","terms","disclaimer","creators","help"].includes(state.tab)) ? state.tab : "home");
     window.scrollTo({top:0,behavior:"auto"});
   };
   const current=window.history.state;
   if(!current?.kivora){
     const watchId=new URLSearchParams(window.location.search).get("watch");
     window.history.replaceState({kivora:true,tab:watchId?"watch":"home",videoId:watchId||undefined},"",watchId?`?watch=${encodeURIComponent(watchId)}`:(window.location.hash||"#home"));
   }
   window.addEventListener("popstate",onPop);
   return()=>window.removeEventListener("popstate",onPop);
 },[videos,tab]);

 return <div className="app">
  <header className="topbar">
   <button className="brand" onClick={()=>go("home")}>Kivora</button>
   <div className="topActions">
    <button className="menuBtn" aria-label="Open menu" onClick={()=>setMenu(!menu)}>☰ <span>Menu</span></button>
    {!signedIn&&<button className="signinMini" onClick={google} disabled={busy}>Sign in</button>}
    {signedIn&&<button className="avatar accountAvatar" onClick={()=>go("account")} aria-label={`Account: ${user.email||"Google account"}`} title={user.email||"Google account"}>{user.photoURL?<img src={user.photoURL} alt=""/>:<span>{(user.email||"K").trim().slice(0,1).toUpperCase()}</span>}</button>}
   </div>
   {menu&&<aside className="menuPanel">
    <div className="menuHead"><strong>Explore Kivora</strong><button className="iconBtn" onClick={()=>setMenu(false)}>×</button></div>
    <button onClick={()=>go("home")}>Discover</button><button onClick={()=>go("watchlist")}>Saved videos</button><button onClick={()=>go("history")}>Recently watched</button>
    <div className="menuLine"/>
    <details open><summary>Personalize</summary><div className="menuSub">
      <button onClick={()=>setTheme("light")}>☀ Light mode</button><button onClick={()=>setTheme("dark")}>☾ Dark mode</button><button onClick={()=>setTheme("system")}>◐ System mode</button>
      {installPrompt&&<button onClick={async()=>{installPrompt.prompt();await installPrompt.userChoice;setInstallPrompt(null)}}>＋ Install Kivora</button>}
    </div></details>
    <details><summary>More Kivora</summary><div className="menuSub"><button onClick={()=>go("premium")}>Kivora Pro</button><button onClick={()=>go("ads")}>Advertise with Kivora</button><button onClick={notifications}>🔔 Notifications {pendingNewVideos>0?`(${Math.min(pendingNewVideos,10)}/10)`:""}</button></div></details>
    <details><summary>Help & FAQs</summary><div className="menuSub"><button onClick={()=>go("faqs")}>Frequently asked questions</button><button onClick={()=>go("help")}>Help & contact</button></div></details>
    <details><summary>Legal & policies</summary><div className="menuSub"><button onClick={()=>go("about")}>About Kivora</button><button onClick={()=>go("privacy")}>Privacy</button><button onClick={()=>go("terms")}>Terms</button><button onClick={()=>go("disclaimer")}>Disclaimer</button><button onClick={()=>go("creators")}>Creators & rights holders</button></div></details>
    <details><summary>YouTube</summary><div className="menuSub"><a href="https://www.youtube.com/" target="_blank" rel="noreferrer">Open YouTube ↗</a><span className="menuHint">Use YouTube directly for actions such as comments, subscriptions, channel management and other YouTube features.</span></div></details>
    {user&&<><div className="menuLine"/><button onClick={async()=>{await logOut();go("home");}}>Sign out</button></>}
   </aside>}
  </header>

  {notifyPrompt&&"Notification"in window&&Notification.permission==="default"&&
   <div className="notifyPrompt"><button className="x" onClick={()=>setNotifyPrompt(false)}>×</button><b>Stay in the loop</b><span>Get Kivora updates without hunting for them.</span><button className="primary" onClick={notifications}>Enable notifications</button></div>}

  {!user&&<section className="welcome"><div><small>WELCOME TO KIVORA</small><h2>Watch first. Decide later.</h2><p>Start instantly as a guest, or connect Google to keep your Kivora activity across devices.</p></div><div className="welcomeActions"><button className="primary" onClick={guest} disabled={busy}>Start watching</button><button onClick={google} disabled={busy}>Continue with Google</button></div></section>}

  <main>
   {tab==="watch"&&selectedVideo&&<VideoWatchPage video={selectedVideo} relatedVideos={videos} sponsored={sponsored} user={user} isPro={premium} onNotice={setNotice} onBack={()=>go("home")} onOpenVideo={openVideo}/>}
   {tab==="home"&&<>
    <nav className="categoryNav" aria-label="Video categories">{[
      ["suggested","Suggested"],["all","All"],["new","New"],["hollywood","Hollywood"],
      ["bollywood","Bollywood"],["chinese","Chinese"],["korean","Korean"],["japanese","Japanese"],
      ["nollywood","Nollywood"],["southindian","South Indian"],["thai","Thai"],["indonesian","Indonesian"]
    ].map(([key,label])=><button key={key} className={category===key?"active":""} onClick={()=>{setCategory(key);setQuery("")}}>{label}</button>)}</nav>
    <section className="discoverTools"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search movies, shows, creators…" aria-label="Search Kivora videos"/><span>{query?"Search results":"Action movies ranked using engagement and viewer ratings."}</span></section>
    {videoLoading&&<section className="sourceNote"><b>Finding videos…</b><p>Kivora is loading live YouTube discovery results.</p></section>}
    {videoError&&<section className="sourceNote"><b>Video discovery notice</b><p>{videoError}</p>{query.trim()&&<button onClick={()=>setQuery("")}>Back to Discover</button>}</section>}
    <div className="feed">{(()=>{
      const ranked=videos.filter(v=>{const r=ratings[v.id]||{};const item={...v,...r};return !isLikelySpam(item)&&(query.trim()?true:canRecommend(item));}).map(v=>{
        const r=ratings[v.id]||{};
        const viewerRating=effectiveOriginality(r.ratingAverage,r.ratingCount);
        const engagement=Number(v.engagementScore||0);
        const recScore=(viewerRating/5)*60 + Math.min(40,engagement*2.2);
        return {...v,recScore};
      });
      ranked.sort((a,b)=>category==="new"?new Date(b.publishedAt||0)-new Date(a.publishedAt||0):b.recScore-a.recScore);
      const cards=[];
      ranked.forEach((v,i)=>{
        cards.push(<VideoCard key={v.id} video={v} user={user} onNotice={setNotice} isPro={premium} suggested={!query.trim() && category!=="new" && i<5} onOpen={openVideo}/>);
        if(sponsored.length && (i===2 || (i>2 && (i-2)%5===0))){const ad=sponsored[Math.min(Math.floor(i/5),sponsored.length-1)];cards.push(<SponsoredCard key={`ad-${ad.id}-${i}`} campaign={ad} onNotice={setNotice}/>);}
      });
      if(!cards.length&&!videoLoading)cards.push(<section className="emptyState" key="empty"><h3>No videos to show</h3><p>Try another category or search term.</p></section>);
      return cards;
    })()}</div>
    <div ref={feedSentinelRef} className="feedSentinel" aria-live="polite">{loadingMore&&<><span className="feedSpinner"/>Finding more movies…</>}{!loadingMore&&!hasMore&&videos.length>0&&<span>You've reached the end of the currently available results.</span>}</div>
    <details className="sourceNote sourceDetails"><summary><b>How Kivora's feed works</b></summary><p>Suggested videos combine public YouTube engagement signals with Kivora viewer ratings. New sorts by publication date. Categories focus on action movies across major film industries. Recaps, explainers, reviews, reactions, trailers, Shorts and similar non-movie results are filtered out. Sponsored placements are clearly labelled and inserted into the same FYP flow as other content.</p></details>
    <details className="sourceNote sourceDetails"><summary><b>Subtitles & language</b></summary><p>Kivora can use the official YouTube player's caption system when a source video provides captions. You can turn captions on/off and choose a preferred caption language. YouTube decides which original or translated caption tracks are available; Kivora does not download or re-host caption files.</p></details>
    <details className="sourceNote sourceDetails"><summary><b>How Kivora gets videos</b></summary><p>Kivora uses official YouTube video IDs and metadata, then plays the creator's video through YouTube's official embedded player. The original source, creator and YouTube controls remain attributable to the source platform.</p><button onClick={()=>go("creators")}>Read our creator & rights policy →</button></details>
   </>}
   {tab==="watchlist"&&<Saved user={user} videos={videos} onNotice={setNotice}/>}
   {tab==="history"&&<section className="panel"><h1>Recently watched</h1><p>Your local viewing history will appear here. Kivora keeps this separate from YouTube's own view history.</p></section>}
   {tab==="account"&&<section className="panel"><h1>Your Kivora account</h1><p>{signedIn?"Google is connected. Your saved Kivora activity can sync across devices.":"You're using a guest session on this device."}</p>{!signedIn&&<button className="primary" onClick={google}>Connect Google</button>}</section>}
   {tab==="premium"&&<Premium user={user} onNotice={setNotice} owner={owner}/>}
   {tab==="ads"&&(signedIn?<AdStudio owner={owner}/>:<section className="panel"><h1>Advertise with Kivora</h1><p>Sign in with Google before creating a campaign.</p><button className="primary" onClick={google}>Continue with Google</button></section>)}
   {tab==="faqs"?<FAQs/>:["about","privacy","terms","disclaimer","creators","help"].includes(tab)?<Legal page={tab}/>:null}
  </main>
  <footer>Kivora · Independent entertainment discovery · Source attribution matters.</footer>
  {notice&&<div className="toast" role="status">{notice}<button onClick={()=>setNotice("")}>×</button></div>}
 </div>
}

function loadYouTubeApi(callback){
 if(window.YT?.Player){callback();return;}
 window.__kivoraYTQueue=window.__kivoraYTQueue||[];
 window.__kivoraYTQueue.push(callback);
 if(!document.getElementById("yt-api")){
  const s=document.createElement("script");
  s.id="yt-api";
  s.src="https://www.youtube.com/iframe_api";
  s.async=true;
  document.head.appendChild(s);
  window.onYouTubeIframeAPIReady=()=>{const q=window.__kivoraYTQueue||[];window.__kivoraYTQueue=[];q.forEach(fn=>{try{fn()}catch{}})};
 }
}

function formatDuration(seconds=0){
 const n=Math.max(0,Math.trunc(Number(seconds)||0));
 const h=Math.floor(n/3600),m=Math.floor((n%3600)/60),s=n%60;
 return h?`${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`:`${m}:${String(s).padStart(2,"0")}`;
}

function RotatePhoneIcon(){
 return <svg className="rotatePhoneIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="7" y="3.5" width="10" height="17" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.8"/><circle cx="12" cy="17.7" r=".8" fill="currentColor"/><path d="M4 8.2a8.2 8.2 0 0 1 3.4-3.4M20 15.8a8.2 8.2 0 0 1-3.4 3.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><path d="m5.1 4.3 2.5.2-.7 2.4M18.9 19.7l-2.5-.2.7-2.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
}

function YouTubePlayer({video,isPro,onNotice,compact=false}){
 const box=useRef(null),player=useRef(null),speedTimer=useRef(null);
 const [activated,setActivated]=useState(true),[muted,setMuted]=useState(false),[captions,setCaptions]=useState(false),[captionLang,setCaptionLang]=useState("en"),[landscape,setLandscape]=useState(false),[toolsVisible,setToolsVisible]=useState(true),[speed,setSpeed]=useState(1);
 useEffect(()=>{
  let cancelled=false;
  const load=()=>{
   if(cancelled||!window.YT?.Player||!box.current||!document.getElementById(`yt-watch-${video.id}`))return;
   player.current=new window.YT.Player(`yt-watch-${video.id}`,{
    videoId:video.id,width:"100%",height:"100%",
    playerVars:{autoplay:0,controls:1,rel:0,playsinline:1,enablejsapi:1,color:"white",cc_load_policy:captions?1:0,cc_lang_pref:captionLang,origin:window.location.origin},
    events:{
      onReady:()=>{if(captions){try{player.current.loadModule("captions");player.current.setOption("captions","track",{language:captionLang});}catch{}}},
      onAutoplayBlocked:()=>onNotice("YouTube blocked automatic playback. Tap the player to start it.")
    }
   });
  };
  loadYouTubeApi(load);
  return()=>{cancelled=true;try{player.current?.destroy()}catch{}player.current=null};
 },[video.id,activated]);
 useEffect(()=>{setToolsVisible(true);return()=>{if(speedTimer.current)clearInterval(speedTimer.current)}},[]);
 function revealTools(){
  // Player utility controls are intentionally permanent.
  // The 4-second auto-hide behavior is not used on the watch page.
  setToolsVisible(true);
 }
 function mute(){if(!player.current)return;try{if(muted){player.current.unMute();setMuted(false)}else{player.current.mute();setMuted(true)}revealTools()}catch{}}
 function restartPlayer(nextCaptions=captions,nextLang=captionLang){
  try{player.current?.destroy()}catch{}
  player.current=null;
  const el=document.getElementById(`yt-watch-${video.id}`); if(el)el.innerHTML="";
  setActivated(false); setTimeout(()=>setActivated(true),30);
  setCaptions(nextCaptions); setCaptionLang(nextLang); revealTools();
 }
 function toggleCaptions(){
  if(!isPro){onNotice("Subtitle controls and translated subtitle selection are a Kivora Pro feature.");return;}
  if(!video.hasCaptions){onNotice("This video does not advertise a caption track through YouTube.");return;}
  const next=!captions; restartPlayer(next,captionLang); onNotice(next?`Subtitles on · preferred language ${captionLang}`:"Subtitles off");
 }
 function changeCaptionLanguage(lang){
  if(!isPro){onNotice("Subtitle language selection is a Kivora Pro feature.");return;}
  if(!video.hasCaptions){onNotice("This video does not advertise a caption track through YouTube.");return;}
  // Apply YouTube's supported cc_lang_pref parameter by recreating the official player.
  restartPlayer(true,lang);
  onNotice(`Preferred subtitle language: ${lang}. YouTube will use it when that caption/translation track is available.`);
 }
 async function goLandscape(){
  try{if(!document.fullscreenElement)await box.current?.requestFullscreen?.();await screen.orientation?.lock?.("landscape");setLandscape(true);revealTools()}catch{onNotice("Landscape mode is only available where your browser/device supports orientation locking.")}
 }
 function setPlaybackRate(rate){
  try{player.current?.setPlaybackRate?.(rate);setSpeed(rate);revealTools()}catch{onNotice("This YouTube video does not expose that playback speed.")}
 }
 function startForward(){
  if(speedTimer.current)clearInterval(speedTimer.current);
  setPlaybackRate(2);
 }
 function startBackward(){
  if(speedTimer.current)clearInterval(speedTimer.current);
  setSpeed(2);
  speedTimer.current=setInterval(()=>{
   try{
    const current=Number(player.current?.getCurrentTime?.()||0);
    player.current?.seekTo?.(Math.max(0,current-0.5),true);
   }catch{}
  },250);
  revealTools();
 }
 function stopSpeed(){
  if(speedTimer.current){clearInterval(speedTimer.current);speedTimer.current=null;}
  if(speed!==1)setPlaybackRate(1);
 }
 function holdProps(start){
  return {
   onPointerDown:e=>{e.preventDefault();start();},
   onPointerUp:e=>{e.preventDefault();stopSpeed();},
   onPointerCancel:stopSpeed,
   onPointerLeave:stopSpeed,
   onKeyDown:e=>{if(e.key===' '||e.key==='Enter'){e.preventDefault();start();}},
   onKeyUp:e=>{if(e.key===' '||e.key==='Enter'){e.preventDefault();stopSpeed();}},
   onContextMenu:e=>e.preventDefault()
  };
 }
 if(!activated)return <div className={`playerWrap watchPlayer ${compact?"compactWatchPlayer":""}`} ref={box}/>;
 return <>
   <div className={`playerWrap watchPlayer ${compact?"compactWatchPlayer":""}`} ref={box} onPointerDown={revealTools}>
    <div id={`yt-watch-${video.id}`} className="ytPlayer"/>
   </div>
   <div className={`watchControls ${toolsVisible?"visible":"hidden"}`} aria-label="Kivora video controls" onPointerDown={revealTools}>
     <button className="iconTool" onClick={mute} aria-label={muted?"Unmute":"Mute"} title={muted?"Unmute":"Mute"}>{muted?"🔇":"🔊"}</button>
     <button className="iconTool rotatePhoneTool" onClick={goLandscape} aria-label="Rotate phone to landscape" title="Rotate phone to landscape"><RotatePhoneIcon/></button>
     <button className="iconTool" {...holdProps(startBackward)} aria-label="Hold to rewind at 2x" title="Hold to rewind 2x">◀<small>2×</small></button>
     <button className="iconTool" {...holdProps(startForward)} aria-label="Hold to play forward at 2x" title="Hold to play 2x">▶<small>2×</small></button>
     <button className="iconTool speedReadout" onClick={()=>setPlaybackRate(speed===1?2:1)} aria-label="Toggle 1x or 2x playback speed" title="Toggle playback speed">{speed}×</button>
     <button className={`iconTool ${!isPro?"proTool":""}`} onClick={toggleCaptions} aria-label={captions?"Turn subtitles off":"Turn subtitles on"} title={captions?"Subtitles on":"Subtitles off"}>CC</button>
     <select className="iconSelect" value={captionLang} onChange={e=>changeCaptionLanguage(e.target.value)} aria-label="Subtitle language" disabled={!isPro||!video.hasCaptions} title="Subtitle language">
       <option value="en">EN</option><option value="zh-Hans">中简</option><option value="zh-Hant">中繁</option><option value="hi">HI</option><option value="ko">KO</option><option value="ja">JA</option><option value="ar">AR</option><option value="fr">FR</option><option value="es">ES</option><option value="pt">PT</option>
     </select>
   </div>
 </>;
}

function VideoCard({video,user,onNotice,isPro=false,suggested=false,onOpen}){
 const [liked,setLiked]=useState(false),[likes,setLikes]=useState(0),[saved,setSaved]=useState(false);
 useEffect(()=>{if(!user)return;const key=`kivora-like-${video.id}-${user.uid}`;setLiked(localStorage.getItem(key)==="1");},[user,video.id]);
 async function like(e){e.stopPropagation();const uid=user?.uid||"guest";try{const next=user?await toggleLike(video.id,user.uid):(localStorage.getItem(`kivora-like-${video.id}-guest`)!=="1");setLiked(next);localStorage.setItem(`kivora-like-${video.id}-${uid}`,next?"1":"0");setLikes(x=>Math.max(0,x+(next?1:-1)));if(!user)onNotice("Liked on this device. Connect Google to sync your Kivora activity.");}catch(e2){onNotice(e2.message)}}
 async function save(e){e.stopPropagation();const uid=user?.uid||"guest";try{const next=user?await saveVideo(video.id,user.uid):(localStorage.getItem(`kivora-saved-${video.id}-guest`)!=="1");setSaved(next);localStorage.setItem(`kivora-saved-${video.id}-${uid}`,next?"1":"0");if(!user)onNotice("Saved on this device. Connect Google to sync your Kivora activity.");}catch(e2){onNotice(e2.message)}}
 function share(e){e.stopPropagation();const url=`${location.origin}/?watch=${encodeURIComponent(video.id)}`;if(navigator.share){navigator.share({title:video.title,url}).catch(err=>{if(err?.name!=="AbortError")onNotice("Share was cancelled or unavailable.")});return}if(navigator.clipboard?.writeText){navigator.clipboard.writeText(url).then(()=>onNotice("Kivora link copied.")).catch(()=>onNotice("Copy the page link to share."));return}onNotice("Copy the page link to share.")}
 return <article className="videoCard feedVideoCard" onClick={()=>onOpen?.(video)} role="link" tabIndex={0} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();onOpen?.(video)}}}>
   <div className="playerWrap isThumbnail">
    <div className="thumbnailButton" aria-label={`Open ${video.title}`}>
      <img src={video.thumb} alt="" loading="lazy"/><span className="thumbShade"/><span className="playCircle">▶</span>
      {video.durationSeconds>0&&<span className="durationBadge">{formatDuration(video.durationSeconds)}</span>}
    </div>
   </div>
   <div className="videoBody">
    <div className="videoMetaLine"><div className="eyebrow">{video.lang}</div>{suggested&&<span className="suggestedBadge">SUGGESTED</span>}</div>
    <h2>{video.title}</h2>
    <div className="channelLine"><span className="channelAvatar">{(video.channelTitle||"Y").slice(0,1).toUpperCase()}</span><span><b>{video.channelTitle||"YouTube"}</b><small>{Number(video.viewCount||0).toLocaleString()} views{video.publishedAt?` · ${new Date(video.publishedAt).toLocaleDateString()}`:""}</small></span></div>
    <details className="videoInfo" onClick={e=>e.stopPropagation()}><summary>About this video</summary><p>{video.desc}</p><span>{Number(video.youtubeLikeCount||0).toLocaleString()} YouTube likes · {Number(video.commentCount||0).toLocaleString()} comments · {video.hasCaptions?"Captions available":"Captions not indicated"}</span></details>
    <div className="actionRow compactActions" onClick={e=>e.stopPropagation()}><button onClick={like}>♡ <span className="actionText">{liked?"Liked":"Like"}</span>{likes?` ${likes}`:""}</button><button onClick={save}>＋ <span className="actionText">{saved?"Saved":"Save"}</span></button><button onClick={share}>↗ <span className="actionText">Share</span></button></div>
    <div className="captionHint">Tap to open the full Kivora watch page.</div>
   </div>
 </article>
}

function VideoWatchPage({video,relatedVideos,sponsored,user,onNotice,isPro,onBack,onOpenVideo}){
 const related=relatedVideos.filter(v=>v.id!==video.id&&!isLikelySpam(v)).slice(0,10);
 const [liked,setLiked]=useState(false),[likes,setLikes]=useState(0),[saved,setSaved]=useState(false);
 useEffect(()=>{if(!user)return;setLiked(localStorage.getItem(`kivora-like-${video.id}-${user.uid}`)==="1");},[user,video.id]);
 async function like(){const uid=user?.uid||"guest";try{const next=user?await toggleLike(video.id,user.uid):(localStorage.getItem(`kivora-like-${video.id}-guest`)!=="1");setLiked(next);localStorage.setItem(`kivora-like-${video.id}-${uid}`,next?"1":"0");setLikes(x=>Math.max(0,x+(next?1:-1)));if(!user)onNotice("Liked on this device. Connect Google to sync your Kivora activity.");}catch(e){onNotice(e.message)}}
 async function save(){const uid=user?.uid||"guest";try{const next=user?await saveVideo(video.id,user.uid):(localStorage.getItem(`kivora-saved-${video.id}-guest`)!=="1");setSaved(next);localStorage.setItem(`kivora-saved-${video.id}-${uid}`,next?"1":"0");if(!user)onNotice("Saved on this device. Connect Google to sync your Kivora activity.");}catch(e){onNotice(e.message)}}
 async function share(){const url=`${location.origin}/?watch=${encodeURIComponent(video.id)}`;try{if(navigator.share){await navigator.share({title:video.title,url});return}if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(url);onNotice("Kivora link copied.");return}throw new Error()}catch(e){if(e?.name!=="AbortError")onNotice("Copy the page link to share.")}}
 return <section className="watchPage">
   <div className="watchTop"><button className="backBtn" onClick={onBack}>← Back to FYP</button><span className="watchSource">Kivora · YouTube</span></div>
   <YouTubePlayer video={video} isPro={isPro} onNotice={onNotice}/>
    <div className="watchActions visible" aria-label="Video actions"><button className="watchActionIcon" onClick={e=>{e.stopPropagation();like()}} aria-label={liked?"Unlike":"Like"} title={liked?"Unlike":"Like"}>♡</button><button className="watchActionIcon" onClick={e=>{e.stopPropagation();save()}} aria-label={saved?"Remove from saved":"Save"} title={saved?"Remove from saved":"Save"}>＋</button><button className="watchActionIcon" onClick={e=>{e.stopPropagation();share()}} aria-label="Share" title="Share">↗</button></div>
   <article className="watchInfo">
    <div className="videoMetaLine"><div className="eyebrow">{video.lang}</div></div>
    <h1>{video.title}</h1>
    <div className="watchChannel"><span className="channelAvatar large">{(video.channelTitle||"Y").slice(0,1).toUpperCase()}</span><div><b>{video.channelTitle||"YouTube"}</b><span>{Number(video.viewCount||0).toLocaleString()} views{video.publishedAt?` · ${new Date(video.publishedAt).toLocaleDateString()}`:""}</span></div></div>

    <details className="watchDescription" open><summary>About this video</summary><p>{video.desc}</p><span>{Number(video.youtubeLikeCount||0).toLocaleString()} YouTube likes · {Number(video.commentCount||0).toLocaleString()} comments · {video.hasCaptions?"Captions available":"Captions not indicated"}</span></details>
    <div className="watchNotice">Comments stay on YouTube. Kivora does not add a separate comment system or paid comment API usage here.</div>
   </article>
   <div className="relatedSection">
    <div className="relatedHeading"><div><small>UP NEXT</small><h2>Related action movies</h2></div><span>{related.length} videos</span></div>
    {related.length?related.map((v,i)=><React.Fragment key={v.id}><RelatedVideoCard video={v} onOpen={onOpenVideo}/>{sponsored.length&&((i+1)%4===0)?<SponsoredCard key={`watch-ad-${sponsored[Math.floor(i/4)%sponsored.length].id}-${i}`} campaign={sponsored[Math.floor(i/4)%sponsored.length]} onNotice={onNotice}/>:null}</React.Fragment>):<div className="emptyState"><h3>No related videos yet</h3><p>Go back to the FYP for more action-movie suggestions.</p></div>}
   </div>
 </section>
}

function RelatedVideoCard({video,onOpen}){
 return <article className="relatedCard" onClick={()=>onOpen?.(video)} role="link" tabIndex={0} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();onOpen?.(video)}}}>
  <div className="relatedThumb"><img src={video.thumb} alt="" loading="lazy"/><span className="durationBadge">{formatDuration(video.durationSeconds)}</span><span className="relatedPlay">▶</span></div>
  <div className="relatedBody"><h3>{video.title}</h3><b>{video.channelTitle||"YouTube"}</b><span>{Number(video.viewCount||0).toLocaleString()} views{video.publishedAt?` · ${new Date(video.publishedAt).toLocaleDateString()}`:""}</span></div>
 </article>
}

function OriginalityRating({video,user,onNotice}){
 const [average,setAverage]=useState(3),[count,setCount]=useState(0),[mine,setMine]=useState(0),[saving,setSaving]=useState(false);
 useEffect(()=>{
  let live=true;
  getDoc(doc(db,"videos",video.id)).then(async s=>{if(!live)return;const d=s.data()||{};setAverage(Number(d.ratingAverage||3));setCount(Number(d.ratingCount||0));if(user && !user.isAnonymous){
      const own=await getDoc(doc(db,"videos",video.id,"ratings",user.uid));
      if(own.exists()) setMine(Number(own.data()?.rating||0));
    }}).catch(()=>{});
  return()=>{live=false};
 },[video.id,user]);
 async function vote(v){
  if(!user || user.isAnonymous){onNotice("Connect Google to rate originality.");return;}
  if(mine>0){onNotice("You have already rated this video with this Google account.");return;}
  if(saving)return; setSaving(true);
  try{const r=await rateVideo(video.id,user.uid,v);setMine(v);setAverage(r.average);setCount(r.count);onNotice("Originality rating saved.");}
  catch(e){onNotice("Rating could not be saved right now.");}
  finally{setSaving(false);}
 }
 const shown=Math.round(average*10)/10;
 return <div className="originalityBox" aria-label="Kivora originality rating">
  <div className="ratingTop"><b>How original does this video appear?</b><span>{count ? `${shown.toFixed(1)} / 5 · ${count} rating${count===1?"":"s"}` : "Not rated yet"}</span></div>
  <div className="stars" aria-label="Rate originality from 1 to 5">{[1,2,3,4,5].map(n=><button key={n} className={(mine>0 ? n<=mine : count>0 && n<=Math.round(average))?"star active":"star"} onClick={()=>vote(n)} disabled={saving} aria-label={`${n} out of 5 originality rating`}>★</button>)}</div>
  <div className="ratingNote">ⓘ These stars are <b>only for perceived originality</b>, not popularity, likes or copyright ownership. Ratings help decide how strongly Kivora surfaces a video in Search, FYP and suggestions. Low ratings reduce recommendations; they do not delete the video.</div>
  {mine>0&&<small className="yourRating">Your rating: {mine}/5</small>}
 </div>
}

function Saved({user,videos,onNotice}){
 const [saved,setSaved]=useState([]);
 useEffect(()=>{if(user&&!user.isAnonymous)getDoc(doc(db,"users",user.uid)).then(s=>setSaved(s.data()?.savedVideos||[]))},[user]);
 return <section className="panel"><h1>Saved videos</h1>{!saved.length?<p>Nothing saved yet. Tap Save under a video to keep it here.</p>:videos.filter(v=>saved.includes(v.id)).map(v=><div className="savedItem" key={v.id}><img src={v.thumb}/><div><b>{v.title}</b><p>{v.desc}</p></div></div>)}</section>
}

function Premium({user,onNotice,owner=false}){
 const [loading,setLoading]=useState(false);
 const liveRef=useRef(true);
 useEffect(()=>()=>{liveRef.current=false},[]);
 async function checkout(){
  if(owner){onNotice("Owner access: Kivora Pro is free for this account.");return;}
  if(!user||user.isAnonymous){onNotice("Connect Google before purchasing Pro.");return;}
  setLoading(true);
  onNotice("Opening secure checkout…");
  setTimeout(()=>{
   if(!liveRef.current)return;
   setLoading(false);
   onNotice("Checkout endpoint is not configured yet. Add the server-side Flutterwave verification before accepting payment.");
  },500);
 }
 const benefits=[
  "YouTube caption controls when the source video provides captions",
  "Subtitle language selection using the embedded YouTube player",
  "Kivora's translated-caption preference where YouTube provides that track",
  "Saved videos and expanded personal collections",
  "Ad-reduced Kivora browsing experience",
  "Full-screen and landscape playback controls",
  "Faster access to related action-movie recommendations",
  "Future Pro-only Kivora features as they are released"
 ];
 return <section className="panel pro"><small>KIVORA PRO</small><h1>More control over your movie experience.</h1><p><b>Pro features are listed clearly before payment.</b> Subtitle behavior still depends on what YouTube makes available for each source video. Kivora does not download or re-host the video's captions.</p><div className="proPriceBox"><b>Pro access</b><span>USD price is configured server-side with a Naira equivalent shown before checkout.</span><span>Payment is verified server-side through Flutterwave before Pro is granted.</span></div><div className="proBenefits"><h2>What you get with Pro</h2><ul>{benefits.map(x=><li key={x}><span className="proCheck">✓</span><span>{x}</span></li>)}</ul></div><div className="proGrid"><div><b>Free</b><span>Core discovery, FYP, related videos, saved-video basics and standard YouTube playback.</span></div><div><b>Pro</b><span>Expanded Kivora convenience features, caption-language controls and reduced Kivora advertising.</span></div></div><button className="primary" onClick={checkout} disabled={loading}>{loading?"Opening…":owner?"Pro enabled for owner":"Continue to secure checkout"}</button><p className="tiny">{owner?"Owner billing bypass is enabled for the configured Kivora owner account.":"No client-side paid flag unlocks Pro. The server must verify payment first."}</p></section>
}

function AdStudio({owner=false}){
 const [step,setStep]=useState("prep"),[format,setFormat]=useState(""),[status,setStatus]=useState(""),[submitting,setSubmitting]=useState(false);
 const [form,setForm]=useState({brand:"",title:"",description:"",assetId:"",site:"",country:"",targetImpressions:"1500",duration:"1"});
 const update=(k,v)=>setForm(x=>({...x,[k]:v}));
 const choose=f=>{setFormat(f);setStep("form");setStatus("");};
 const isDriveId=v=>/^[A-Za-z0-9_-]{20,}$/.test(v.trim());
 const isYouTube=v=>/^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[A-Za-z0-9_-]{6,}/i.test(v.trim());
 const BANNER_PRICE_PER_BLOCK=1.99;
 const VIDEO_PRICE_PER_BLOCK=2.99;
 const IMPRESSION_BLOCK=1500;
 const days=Math.max(1,Math.min(90,Number(form.duration)||1));
 const targetImpressions=Math.max(0,Math.floor(Number(String(form.targetImpressions).replace(/[^0-9]/g,""))||0));
 const billableBlocks=targetImpressions>0?Math.ceil(targetImpressions/IMPRESSION_BLOCK):0;
 const billableImpressions=billableBlocks*IMPRESSION_BLOCK;
 const pricePerBlock=format==="video"?VIDEO_PRICE_PER_BLOCK:BANNER_PRICE_PER_BLOCK;
 const estimatedBill=owner?0:Number((billableBlocks*pricePerBlock).toFixed(2));
 function preflight(){
  const text=Object.values(form).join(" ").toLowerCase();
  const political=["vote","election","candidate","political party","campaign","ballot","president","governor","senator","politician","electoral"].some(x=>text.includes(x));
  const adult=["porn","pornography","xxx","escort","onlyfans","nude","nudes","adult content"].some(x=>text.includes(x));
  if(political)return "Rejected: political advertising is not permitted.";
  if(adult)return "Rejected: adult/sexually explicit advertising is not permitted.";
  if(!/^https?:\/\//i.test(form.site.trim()))return "Rejected: enter a valid destination URL.";
  if(!form.brand.trim()||!form.title.trim())return "Rejected: brand and campaign title are required.";
  if(!Number.isInteger(targetImpressions)||targetImpressions<1500)return "Rejected: enter at least 1,500 target impressions.";
   if(targetImpressions>100000000)return "Rejected: target impressions cannot exceed 100,000,000.";
  if(!days||days>90)return "Rejected: campaign duration must be 1–90 days.";
  if(format!=="video" && !isDriveId(form.assetId) && !/^https?:\/\//i.test(form.assetId))return "Rejected: use a Google Drive file ID or a permitted public image URL.";
  if(format==="video" && !isDriveId(form.assetId) && !isYouTube(form.assetId))return "Rejected: video must be a Google Drive file ID or YouTube URL.";
  if(format==="video" && isLikelySpam({title:form.title,description:form.description}))return "Rejected: campaign text triggered the anti-spam check.";
  return "PASS";
 }
 async function submit(e){e.preventDefault();if(submitting)return;setSubmitting(true);setStatus("");const result=preflight();if(result!=="PASS"){setStatus(result);setSubmitting(false);return;}setStatus(`Preflight passed. ${owner?"Owner billing bypass applies. No payment is required.":"Estimated bill: "+moneyUsdNgn(estimatedBill)+" for "+billableImpressions.toLocaleString()+" billable impressions ("+billableBlocks+" × 1,500 at "+moneyUsdNgn(pricePerBlock)+"). Final charge is created only after server-side validation."}`);setStep("review");setSubmitting(false);}
 if(step==="prep")return <section className="panel"><h1>Advertise with Kivora</h1><p>Every campaign goes through preflight checks before a bill is created. We store monitoring data separately from viewer actions and never count an ad impression as a YouTube view.</p><div className="steps"><div>1. Choose a format.</div><div>2. Provide a Drive asset ID or an approved YouTube URL.</div><div>3. Review the estimated bill before payment.</div><div>4. Server validates, bills and activates only after verification.</div></div><button className="primary" onClick={()=>setStep("formats")}>Choose format</button></section>;
 if(step==="formats")return <section className="panel"><button onClick={()=>setStep("prep")}>← Back</button><h1>Choose format</h1><div className="formatGrid"><button className="formatCard" onClick={()=>choose("square")}><b>Square banner</b><span>1080 × 1080 · Google Drive ID</span><strong>{moneyUsdNgn(1.99)} / 1,500 impressions</strong></button><button className="formatCard" onClick={()=>choose("rectangle")}><b>Rectangle banner</b><span>1200 × 628 · Google Drive ID</span><strong>{moneyUsdNgn(1.99)} / 1,500 impressions</strong></button><button className="formatCard" onClick={()=>choose("video")}><b>Video campaign</b><span>Google Drive ID or YouTube URL</span><strong>{moneyUsdNgn(2.99)} / 1,500 impressions</strong></button></div></section>;
 if(step==="review")return <section className="panel"><button onClick={()=>setStep("form")}>← Edit campaign</button><h1>Bill preview</h1><div className="priceBox"><b>Estimated bill: {moneyUsdNgn(estimatedBill)}</b><span>{owner?"Owner rate: $0.00 (billing bypass)":`Rate: ${moneyUsdNgn(pricePerBlock)} / 1,500 impressions`}</span><span>Target impressions: {targetImpressions.toLocaleString()}</span><span>Billable impressions: {billableImpressions.toLocaleString()}</span><span>Duration: {days} day{days===1?"":"s"}</span><small>{owner?"This account is exempt from Kivora advertising charges, but campaign validation and monitoring still apply.":"No payment should be captured until the server re-checks the campaign, asset access, price, currency, ownership and campaign status."}</small></div><button className="primary" onClick={()=>setStatus("Payment endpoint must create the checkout server-side. No charge has been attempted by this screen.")}>Continue to secure payment</button>{status&&<div className="status">{status}</div>}</section>;
 const meta={square:["Square banner",moneyUsdNgn(1.99)+" / 1,500 impressions"],rectangle:["Rectangle banner",moneyUsdNgn(1.99)+" / 1,500 impressions"],video:["Video campaign",moneyUsdNgn(2.99)+" / 1,500 impressions"]}[format];
 return <section className="panel"><button onClick={()=>setStep("formats")}>← Change format</button><h1>{meta[0]}</h1><form onSubmit={submit}>{[["assetId",format==="video"?"Google Drive file ID or YouTube URL":"Google Drive file ID"],["brand","Brand name"],["title","Campaign title"],["description","Description"],["site","Destination URL"],["country","Target country"],["targetImpressions","Target impressions"],["duration","Campaign duration (days)"]].map(([k,l])=><label key={k}>{l}<input value={form[k]} onChange={e=>update(k,e.target.value)} required/></label>)}<div className="priceBox"><span>Rate <b>{owner?"$0.00 (₦0) — owner billing bypass":moneyUsdNgn(pricePerBlock)+" / 1,500 impressions"}</b></span><span>Billable impressions <b>{billableImpressions.toLocaleString()}</b></span><span>Estimated bill <b>{moneyUsdNgn(estimatedBill)}</b></span><small>{owner?"No payment is required for the configured owner account. Campaign validation still applies.":"The bill is calculated before payment. It is not a final charge until the server validates it."}</small></div><button className="primary" disabled={submitting}>{submitting?"Checking…":"Review bill before payment"}</button></form>{status&&<div className="status">{status}</div>}</section>
}

function SponsoredCard({campaign,onNotice}){
 const isVideo=campaign.format==="video";
 const youtubeId=extractYouTubeId(campaign.assetId||campaign.youtubeUrl||"");
 const imageUrl=campaign.assetUrl||campaign.imageUrl||(campaign.assetId?`https://drive.google.com/uc?export=view&id=${encodeURIComponent(campaign.assetId)}`:"");
 return <article className="videoCard sponsoredCard">
   <div className="sponsoredTop"><span>SPONSORED</span><small>Paid placement</small></div>
   <div className="sponsorMedia">{isVideo&&youtubeId?<iframe title={campaign.title||"Sponsored video"} src={`https://www.youtube-nocookie.com/embed/${youtubeId}?rel=0&playsinline=1`} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen/>:imageUrl?<img src={imageUrl} alt={campaign.title||"Sponsored content"}/>:<div className="assetMissing">Sponsored media unavailable</div>}</div>
   <div className="videoBody"><div className="eyebrow">SPONSORED · {campaign.brand||"Advertiser"}</div><h2>{campaign.title||"Sponsored content"}</h2><details className="videoInfo" open><summary>About this promotion</summary><p>{campaign.description||"Paid promotional content shown by Kivora."}</p></details><div className="actionRow"><a className="primary softBtn" href={campaign.site} target="_blank" rel="noopener noreferrer">Visit advertiser ↗</a><button onClick={()=>onNotice("This is a paid Kivora placement. Sponsored content is separate from YouTube's organic recommendations.")}>Why sponsored?</button></div></div>
 </article>
}

function extractYouTubeId(value=""){
 try{const u=new URL(value.startsWith("http")?value:`https://${value}`); if(u.hostname.includes("youtu.be")) return u.pathname.slice(1).split("/")[0]; if(u.hostname.includes("youtube.com")) return u.searchParams.get("v")||u.pathname.split("/").filter(Boolean).pop()||"";}catch{} return "";
}

function FAQs(){
 const items=[
  ["Where do Kivora videos come from?","Kivora discovers video metadata through YouTube's API and plays the source through YouTube's official embedded player. Kivora does not download or re-host the audiovisual stream."],
    ["Are sponsored videos clearly marked?","Yes. Paid campaigns that pass Kivora's approval flow are shown in the FYP with a Sponsored label."],
  ["How much does advertising cost?",`Image/banner placements are ${moneyUsdNgn(1.99)} per 1,500 impressions. Video advertising is ${moneyUsdNgn(2.99)} per 1,500 impressions. Naira figures are display estimates using ₦${USD_TO_NGN_DISPLAY_RATE.toLocaleString()} per $1; the server remains authoritative for the final payment currency and amount.`],
  ["Does Kivora replace YouTube?","No. YouTube remains the source for YouTube content, playback, creator attribution and YouTube-specific actions."],
  ["Can I use Kivora in dark mode?","Yes. Choose Light, Dark or System mode from the menu. Your preference is saved on this device."],
  ["What native-style features does Kivora provide?","Kivora supports installable PWA behavior where the browser allows it, fullscreen playback, device sharing, saved videos, watch-first access and push notifications after permission is granted."]
 ];
 return <section className="panel faqPanel"><small>KIVORA HELP</small><h1>Frequently asked questions</h1><p>Quick answers about videos, ads, accounts and the Kivora experience.</p>{items.map(([q,a])=><details key={q}><summary>{q}</summary><p>{a}</p></details>)}</section>
}

function Legal({page}){
 const content={
 about:["About Kivora","Kivora is an independent entertainment discovery product. It organizes links and official embedded video sources so viewers can discover long-form entertainment in a Kivora-designed environment. Kivora is not YouTube and does not claim ownership of third-party videos.","Our catalog can use publicly available YouTube metadata and official embed playback. Availability can change when the original source changes, removes, restricts, or disables a video."],
 privacy:["Privacy","Kivora may process account identifiers, saved-video data, notification tokens and basic product analytics needed to operate the service. Anonymous sessions may be used for watch-first access. Payment credentials are handled by the payment provider; Kivora should not store card details.","You can request deletion of Kivora account data through the contact route published by the operator. Third-party services such as Google, YouTube and Firebase may process data under their own terms and privacy policies. Do not submit sensitive personal information through Kivora."],
 terms:["Terms","Use Kivora lawfully and do not attempt to scrape, overload, bypass access controls, manipulate engagement, impersonate creators, or submit material you do not have rights to use. Kivora may remove campaigns or links that violate these rules or applicable law.","Video playback is supplied by the original platform. Kivora does not guarantee availability, accuracy, monetization status or continued access to third-party videos."],
 disclaimer:["Disclaimer","Kivora is an independent discovery service. References, thumbnails, titles and embedded videos can belong to their respective creators, publishers or platforms. Appearance in Kivora is not an endorsement, ownership claim or transfer of copyright.","Kivora does not download or re-host the audiovisual files used in its official embedded player flow. Where a rights holder believes a listing or link is inaccurate or should not appear, use the published contact route so it can be reviewed."],
 creators:["For creators & rights holders","Kivora is designed to make source attribution clear. We store video IDs/metadata and use the official YouTube embed/player rather than downloading or proxying the video. This means the audiovisual stream is supplied by YouTube, subject to the original video's availability and creator/platform settings.","We do not present Kivora likes or saves as YouTube engagement. Those are Kivora-only interactions. Sponsored content is also separated from organic discovery. If you own or represent content and believe a Kivora listing, metadata use, thumbnail, or placement needs correction or removal, contact the operator with the relevant video URL and your rights-holder details."],
 help:["Help & contact","For account, advertising, copyright or source-attribution questions, use the contact address published by the operator before launch. Include the relevant Kivora page URL and enough context to identify the issue.","For video availability or creator attribution, the original YouTube source is the authoritative source. For Kivora-specific data or interactions, Kivora is the appropriate contact."],
 }[page];
 return <section className="panel legal"><small>KIVORA INFORMATION</small><h1>{content[0]}</h1><p>{content[1]}</p><p>{content[2]}</p><div className="noticeBox"><b>Source principle</b><p>Kivora's role is discovery and presentation—not ownership of third-party audiovisual works.</p></div></section>
}
function authMessage(e){const c=e?.code; if(c==="auth/credential-already-in-use"||c==="auth/account-exists-with-different-credential") return "This Google account already has a Kivora account. Signing you into that existing account instead."; if(c==="auth/popup-blocked") return "Google sign-in was blocked by the browser. Kivora will use the secure redirect sign-in instead."; return e?.message||"Sign-in could not be completed."}

createRoot(document.getElementById("root")).render(<App/>);
