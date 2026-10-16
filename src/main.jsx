import React,{useEffect,useRef,useState} from "react";
import {createRoot} from "react-dom/client";
import "./styles.css";
import { isLikelySpam, effectiveOriginality, canRecommend, isEligibleShort } from "./videoDiscovery";
import {
 auth,db,signInWithGoogle,finishGoogleRedirect,onAuthStateChanged,
 logOut,getProEntitlement,getYouTubeAccessToken,authedFetch
} from "./firebase";
import {doc,getDoc,setDoc,serverTimestamp,runTransaction,collection,getDocs,query as fsQuery,limit,where} from "firebase/firestore";
import { isKivoraOwner } from "./access.js";
import { apiUrl, publicOrigin, openExternal } from "./native.js";

const EMPTY_VIDEOS=[];
const FEED_CACHE_KEY="kivora-feed-cache-v1";
const FEED_CACHE_MAX_KEYS=30;
const FEED_CACHE_MAX_ITEMS=60;
function feedCacheId(category="all",query=""){return `${String(category||"all").toLowerCase()}::${String(query||"").trim().toLowerCase()}`;}
function readPersistentFeedCache(){try{const value=JSON.parse(localStorage.getItem(FEED_CACHE_KEY)||"{}");return value&&typeof value==="object"?value:{}}catch{return{}}}
function readCachedFeed(category="all",query=""){
 const cache=readPersistentFeedCache();
 const exact=cache[feedCacheId(category,query)];
 if(Array.isArray(exact?.items)&&exact.items.length)return exact.items.filter(v=>v&&v.id&&v.title&&v.thumb);
 // For category feeds, gracefully fall back to that category's last unfiltered feed,
 // then the general feed. Never substitute unrelated cached videos for an explicit search.
 if(String(query||"").trim())return [];
 for(const key of [feedCacheId(category,""),feedCacheId("all","")]){
  const entry=cache[key];if(Array.isArray(entry?.items)&&entry.items.length)return entry.items.filter(v=>v&&v.id&&v.title&&v.thumb);
 }
 return [];
}
function persistFeedCache(category,query,items){
 try{
  if(!Array.isArray(items)||!items.length)return;
  const cache=readPersistentFeedCache(),key=feedCacheId(category,query);
  cache[key]={savedAt:Date.now(),items:items.filter(v=>v&&v.id).slice(0,FEED_CACHE_MAX_ITEMS)};
  const ordered=Object.entries(cache).sort((a,b)=>Number(b[1]?.savedAt||0)-Number(a[1]?.savedAt||0)).slice(0,FEED_CACHE_MAX_KEYS);
  localStorage.setItem(FEED_CACHE_KEY,JSON.stringify(Object.fromEntries(ordered)));
 }catch{/* Cache is best-effort; feed must still work if storage is full or disabled. */}
}
function isYouTubeQuotaError(error){return /quotaExceeded|dailyLimitExceeded|quota\s*(?:has been\s*)?(?:exceeded|reached)|daily\s+(?:api\s+)?limit|youtube.{0,30}quota/i.test(String(error?.message||error||""));}
// Display-only FX reference for showing Naira equivalents beside USD prices.
// Actual payment should use the server-side verified Flutterwave amount.
const USD_TO_NGN_DISPLAY_RATE = 1300;
function usdToNgn(usd){ return Math.round(Number(usd||0) * USD_TO_NGN_DISPLAY_RATE); }
function moneyUsdNgn(usd){ return `$${Number(usd||0).toFixed(2)} (≈ ₦${usdToNgn(usd).toLocaleString()})`; }

function compactCount(value){
 const n=Number(value||0);
 if(!Number.isFinite(n)||n<0)return "0";
 if(n>=1_000_000_000)return `${(n/1_000_000_000).toFixed(n>=10_000_000_000?0:1).replace(/\\.0$/,"")}B`;
 if(n>=1_000_000)return `${(n/1_000_000).toFixed(n>=10_000_000?0:1).replace(/\\.0$/,"")}M`;
 if(n>=1_000)return `${(n/1_000).toFixed(n>=10_000?0:1).replace(/\\.0$/,"")}K`;
 return Math.floor(n).toLocaleString();
}
function youtubeShortUrl(id){return `https://www.youtube.com/shorts/${encodeURIComponent(id)}`;}

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
  embedWidth:Number(item?.player?.embedWidth||0),
  embedHeight:Number(item?.player?.embedHeight||0),
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
 const url=apiUrl(`/api/youtube-search${qs?`?${qs}`:""}`);
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
 const res=await fetch(apiUrl(`/api/youtube-search?videoId=${encodeURIComponent(id)}`),{headers:{accept:"application/json"}});
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
 const [tab,setTab]=useState("home"),[premium,setPremium]=useState(false),[menu,setMenu]=useState(false);
 const [user,setUser]=useState(auth.currentUser),[busy,setBusy]=useState(false),[notice,setNotice]=useState("");
 const [audioConsent]=useState(()=>localStorage.getItem("kivora-audio-consent")==="granted");
 const [ratings,setRatings]=useState({}),[query,setQuery]=useState(""),[category,setCategory]=useState("all"),[videos,setVideos]=useState(EMPTY_VIDEOS),[pageTokens,setPageTokens]=useState([]),[hasMore,setHasMore]=useState(true),[loadingMore,setLoadingMore]=useState(false),[sponsored,setSponsored]=useState([]),[videoLoading,setVideoLoading]=useState(true),[videoError,setVideoError]=useState(""),[theme,setTheme]=useState(()=>localStorage.getItem("kivora-theme")||"system"),[installPrompt,setInstallPrompt]=useState(null),[selectedVideo,setSelectedVideo]=useState(null);
 const [authReady,setAuthReady]=useState(false),[categoryMenuOpen,setCategoryMenuOpen]=useState(false),[searchOpen,setSearchOpen]=useState(false),[shuffleOrder,setShuffleOrder]=useState([]);
 const [barHidden,setBarHidden]=useState(false);
 const feedSentinelRef=useRef(null),feedCacheRef=useRef({}),feedRequestRef=useRef(0),seenRef=useRef(null),orderRef=useRef({rank:new Map(),batch:0}),autoMoreRef=useRef(0);
 if(!seenRef.current)seenRef.current=readSeen();
 const signedIn=!!user&&!user.isAnonymous;
 const owner=isKivoraOwner(user);


 useEffect(()=>{
   const params=new URLSearchParams(window.location.search);
   const payment=params.get("payment");
   const campaignId=params.get("campaignId");
   const transactionId=params.get("transaction_id");
   if(payment!=="campaign"||!campaignId)return;
   let cancelled=false;
   (async()=>{
     try{
       const u=auth.currentUser;
       if(!u||u.isAnonymous)return;
       let r,d={};
       for(let attempt=0;attempt<4&&!cancelled;attempt++){
         r=await authedFetch(apiUrl("/api/ad-campaign?action=verify"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({campaignId,transactionId:transactionId||""})});
         d=await r.json().catch(()=>({}));
         if(r.ok&&d.verified)break;
         if(r.status!==402)break;
         await new Promise(res=>setTimeout(res,2500));
       }
       if(cancelled)return;
       setNotice(r.ok&&d.verified?"Payment verified. Your sponsored Short is now ready for delivery.":(d.error||"Payment is still pending."));
       window.history.replaceState({},"",window.location.pathname);
     }catch(e){
       if(!cancelled)setNotice("Payment verification could not be completed yet. You can return to Advertise and retry verification.");
     }
   })();
   return()=>{cancelled=true};
 },[user]);
 useEffect(()=>{
   const apply=()=>{const dark=theme==="dark"||(theme==="system"&&window.matchMedia?.("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.theme=dark?"dark":"light";document.documentElement.style.colorScheme=dark?"dark":"light";};
   apply(); localStorage.setItem("kivora-theme",theme);
   const mq=window.matchMedia?.("(prefers-color-scheme: dark)"); const fn=()=>theme==="system"&&apply(); mq?.addEventListener?.("change",fn); return()=>mq?.removeEventListener?.("change",fn);
 },[theme]);
 useEffect(()=>{const fn=e=>{e.preventDefault();setInstallPrompt(e)};window.addEventListener("beforeinstallprompt",fn);return()=>window.removeEventListener("beforeinstallprompt",fn)},[]);
 useEffect(()=>{
   if(!("serviceWorker" in navigator) || !import.meta.env.PROD) return;
   let registration;
   navigator.serviceWorker.register("/service-worker.js",{scope:"/"}).then(r=>{registration=r;}).catch(err=>console.warn("Kivora offline support could not initialize:",err));
   const onControllerChange=()=>{ /* A newly activated worker takes control on the next navigation. */ };
   navigator.serviceWorker.addEventListener("controllerchange",onControllerChange);
   return()=>{navigator.serviceWorker.removeEventListener("controllerchange",onControllerChange);};
 },[]);
 useEffect(()=>{if(owner)setPremium(true)},[owner]);
 useEffect(()=>{let live=true;getProEntitlement(user).then(v=>{if(live)setPremium(v)});return()=>{live=false}},[user]);
 useEffect(()=>{
   const off=onAuthStateChanged(auth,u=>{setUser(u);setAuthReady(true)});
   finishGoogleRedirect().then(r=>{
      if(r?.user){setUser(r.user);setNotice("Signed in as "+r.user.displayName?.split(" ")[0]+".");}
    }).catch(e=>{
      // Ignore no-redirect-result (user landed normally, not from a sign-in redirect)
      if(e?.code==="auth/no-auth-event"||e?.code==="auth/null-user") return;
      setNotice(authMessage(e));
    });
   return off;
 },[]);
 // Feed top bar: hide while swiping up to the next Short, reveal again when swiping back down.
 useEffect(()=>{
   const last=new WeakMap();
   const onScroll=e=>{
     const el=e.target;
     if(!el||!el.classList||!el.classList.contains("feed"))return;
     const y=el.scrollTop,prev=last.get(el)??y,dy=y-prev;
     if(y<8){setBarHidden(false);last.set(el,y);return}
     if(Math.abs(dy)<6)return;
     last.set(el,y);
     setBarHidden(dy>0);
   };
   document.addEventListener("scroll",onScroll,true);
   return()=>document.removeEventListener("scroll",onScroll,true);
 },[]);
 useEffect(()=>{ if(notice){const t=setTimeout(()=>setNotice(""),4200);return()=>clearTimeout(t)} },[notice]);
 useEffect(()=>{const onSeen=e=>{const id=String(e?.detail||"");if(id)seenRef.current.add(id)};window.addEventListener("kivora:seen",onSeen);return()=>window.removeEventListener("kivora:seen",onSeen)},[]);
 useEffect(()=>{
   let live=true;
   (async()=>{
     try{
       const snap=await getDocs(fsQuery(collection(db,"campaigns"),where("status","==","ready"),limit(12)));
       if(live)setSponsored(snap.docs.map(d=>({id:d.id,...d.data()})).filter(c=>c.format==="video"&&c.moderationStatus==="approved"&&c.assetStatus==="verified"&&c.paymentStatus==="verified"&&Number(c.remainingImpressions??1)>0));
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
   if(!signedIn)return;
   const q=query.trim(),key=`${category}::${q.toLowerCase()}`,requestId=++feedRequestRef.current;
   setShuffleOrder([]);
   // Always ask YouTube for a fresh result set on category/search changes. Never merge
   // stale in-memory category results into a new discovery response.
   setVideos([]);setPageTokens([]);setHasMore(false);setVideoLoading(true);
   setCategoryMenuOpen(false);
   const timer=setTimeout(async()=>{
    setVideoError("");
    try{
      const result=await fetchKivoraVideos(q,category,[]);
      if(requestId!==feedRequestRef.current)return;
      const unique=Array.from(new Map(result.items.map(v=>[v.id,v])).values());
      // Searches are explicit intent and must show current YouTube matches even if watched before.
      // The ordinary discovery feed suppresses previously watched IDs across app restarts.
      const fresh=q?unique:unique.filter(v=>!seenRef.current.has(v.id));
      feedCacheRef.current[key]={items:fresh,nextPageTokens:result.nextPageTokens};
      persistFeedCache(category,q,fresh);
      setVideos(fresh);
      setPageTokens(result.nextPageTokens);
      setHasMore(result.nextPageTokens.some(Boolean));
      if(!fresh.length&&!result.nextPageTokens.some(Boolean))setVideoError(q?"No videos matched that search. Try another keyword.":"You've caught up on these videos. Refresh or choose another category to discover more.");
    }catch(e){if(requestId===feedRequestRef.current){
      const cached=readCachedFeed(category,q);
      if(cached.length){
       const fallback=q?cached:cached.filter(v=>!seenRef.current.has(v.id));
       setVideos(fallback);setPageTokens([]);setHasMore(false);setVideoError("");
      }else{setVideoError(isYouTubeQuotaError(e)?"":"Videos are temporarily unavailable. Please try again later.");setVideos([]);setPageTokens([]);setHasMore(false);}
    }}
    finally{if(requestId===feedRequestRef.current)setVideoLoading(false);}
   },q?320:0);
   return()=>clearTimeout(timer);
 },[query,category,signedIn]);

 async function loadMoreVideos(){
   if(videoLoading||loadingMore||!hasMore)return;
   setLoadingMore(true);setVideoError("");
   try{
     const result=await fetchKivoraVideos(query.trim(),category,pageTokens);
     const explicitSearch=!!query.trim();
     const candidates=result.items.filter(v=>explicitSearch||!seenRef.current.has(v.id));
     setVideos(prev=>{
       const existing=new Set(prev.map(v=>v.id));
       return [...prev,...candidates.filter(v=>v?.id&&!existing.has(v.id)&&existing.add(v.id))];
     });
     setPageTokens(result.nextPageTokens);
     setHasMore(result.nextPageTokens.some(Boolean));
     const key=feedCacheId(category,query);const combined=[...new Map([...videos,...candidates].map(v=>[v.id,v])).values()];feedCacheRef.current[key]={items:combined,nextPageTokens:result.nextPageTokens};persistFeedCache(category,query,combined);
   }catch(e){
     // Keep the feed usable when YouTube's daily quota is exhausted; existing cards remain on screen.
     if(isYouTubeQuotaError(e)){setHasMore(false);setVideoError("");}
     else if(!videos.length){const cached=readCachedFeed(category,query);if(cached.length)setVideos(query.trim()?cached:cached.filter(v=>!seenRef.current.has(v.id)));else setVideoError("More videos are temporarily unavailable.");}
   }
   finally{setLoadingMore(false);}
 }

 useEffect(()=>{
   const node=feedSentinelRef.current;
   if(!node)return;
   const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))loadMoreVideos()},{root:document.querySelector(".feed"),rootMargin:"1200px 0px"});
   observer.observe(node);
   return()=>observer.disconnect();
 },[videoLoading,loadingMore,hasMore,pageTokens,query,category]);

 useEffect(()=>{autoMoreRef.current=0},[query,category]);
 // If most of the loaded videos were already watched, quietly fetch another page so repeat visits stay fresh.
 useEffect(()=>{
   if(!signedIn||videoLoading||loadingMore||!hasMore||query.trim()||!videos.length||autoMoreRef.current>=3)return;
   const unseen=videos.filter(v=>!seenRef.current.has(v.id)).length;
   if(unseen<12){autoMoreRef.current++;loadMoreVideos();}
 },[videos,videoLoading,loadingMore,hasMore,signedIn]);

 async function guest(){await google()}
 async function google(){setBusy(true);try{const r=await signInWithGoogle();if(r)setNotice("Google sign-in complete.");}catch(e){setNotice(authMessage(e))}finally{setBusy(false)}}

 async function refreshFeed(){
   // Refresh means fetch new YouTube discovery results, not reshuffle the same cards.
   const requestId=++feedRequestRef.current;
   const q=query.trim();
   setVideoLoading(true);setVideoError("");setVideos([]);setPageTokens([]);setHasMore(false);setShuffleOrder([]);
   requestAnimationFrame(()=>document.querySelector(".feed")?.scrollTo({top:0,behavior:"auto"}));
   try{
    const result=await fetchKivoraVideos(q,category,[]);
    if(requestId!==feedRequestRef.current)return;
    const unique=Array.from(new Map(result.items.map(v=>[v.id,v])).values());
    const fresh=q?unique:unique.filter(v=>!seenRef.current.has(v.id));
    setVideos(fresh);setPageTokens(result.nextPageTokens);setHasMore(result.nextPageTokens.some(Boolean));
    feedCacheRef.current[feedCacheId(category,q)]={items:fresh,nextPageTokens:result.nextPageTokens};
    persistFeedCache(category,q,fresh);
    if(!fresh.length&&!result.nextPageTokens.some(Boolean))setVideoError(q?"No videos matched that search. Try another keyword.":"You've caught up on these videos. Choose another category or search YouTube by keyword or creator.");
   }catch(e){if(requestId===feedRequestRef.current){
    const cached=readCachedFeed(category,q);
    if(cached.length){setVideos(q?cached:cached.filter(v=>!seenRef.current.has(v.id)));setPageTokens([]);setHasMore(false);setVideoError("");}
    else if(!isYouTubeQuotaError(e))setVideoError("Videos are temporarily unavailable. Your saved feed could not be loaded.");
   }}
   finally{if(requestId===feedRequestRef.current)setVideoLoading(false);}
 }

 const categories=[["all","For You"],["comedy","Comedy"],["tech","Tech"],["adventure","Adventure"],["science","Science"],["finance","Finance"],["education","Education"],["gaming","Gaming"],["sports","Sports"],["food","Food"],["music","Music"],["beauty","Beauty"],["new","Latest"]];
 function jumpVideo(direction){const feed=document.querySelector(".feed");if(!feed)return;const cards=[...feed.querySelectorAll(":scope > .shortCard")];if(!cards.length)return;const active=cards.reduce((best,card)=>{const d=Math.abs(card.getBoundingClientRect().top-feed.getBoundingClientRect().top);return d<best.d?{card,d}:best},{card:cards[0],d:Infinity}).card;const next=direction>0?active.nextElementSibling:active.previousElementSibling;if(next?.classList?.contains("shortCard"))next.scrollIntoView({behavior:"smooth",block:"start"});}
 const go=(t,{history=true}={})=>{
   setTab(t);
   if(t!=="watch")setSelectedVideo(null);
   setMenu(false);
   if(history){
     const nextHash=window.location.pathname+(t==="home"?"#home":"#"+t);
     window.history.pushState({kivora:true,tab:t},"",nextHash);
   }
   window.scrollTo({top:0,behavior:"auto"});
 };
 useEffect(()=>{
   const handler=async(event)=>{
     const action=event?.detail;
     if(!action)return;
     if(action==="signout"){try{await logOut();go("home");setNotice("You have signed out.");}catch(e){setNotice(e?.message||"Sign out failed.");}return;}
     if(action==="signin"){google();return;}
     if(["ads","account","settings","privacy","terms","about","help","faqs","disclaimer","creators","history","premium"].includes(action)){go(action==="settings"?"account":action);return;}
   };
   window.addEventListener("kivora:quick-menu",handler);
   return()=>window.removeEventListener("kivora:quick-menu",handler);
 },[user,busy]);
 const openFromHistory=v=>{setSelectedVideo(v);setTab("watch");setMenu(false);window.history.pushState({kivora:true,tab:"watch",videoId:v.id},"",window.location.pathname+"?watch="+encodeURIComponent(v.id));window.scrollTo({top:0,behavior:"auto"});};
 const openVideo=video=>{
   setNotice("Kivora Shorts stay in the vertical FYP. Use Share to send the Short without opening a separate watch page.");
 };

 useEffect(()=>{
   const base=window.location.origin;
   const canonical=`${base}/`;
   const title=category!=="all"?`${category[0].toUpperCase()+category.slice(1)} Shorts | Kivora`:"Kivora | Shorts";
   const description="Kivora is a dedicated vertical Shorts experience powered by official YouTube embeds.";
   document.title=title;
   const setMeta=(selector,attrs,content)=>{let el=document.head.querySelector(selector);if(!el){el=document.createElement("meta");Object.entries(attrs).forEach(([k,v])=>el.setAttribute(k,v));document.head.appendChild(el);}el.setAttribute("content",content)};
   setMeta('meta[name="description"]',{name:"description"},description);
   setMeta('meta[property="og:title"]',{property:"og:title"},title);
   setMeta('meta[property="og:description"]',{property:"og:description"},description);
   setMeta('meta[property="og:type"]',{property:"og:type"},"website");
   setMeta('meta[property="og:url"]',{property:"og:url"},canonical);
   setMeta('meta[property="og:site_name"]',{property:"og:site_name"},"Kivora");
   setMeta('meta[name="twitter:card"]',{name:"twitter:card"},"summary_large_image");
   setMeta('meta[name="twitter:title"]',{name:"twitter:title"},title);
   setMeta('meta[name="twitter:description"]',{name:"twitter:description"},description);
   let link=document.head.querySelector('link[rel="canonical"]');if(!link){link=document.createElement("link");link.rel="canonical";document.head.appendChild(link)}link.href=canonical;
   let schema=document.getElementById("kivora-seo-schema");if(!schema){schema=document.createElement("script");schema.id="kivora-seo-schema";schema.type="application/ld+json";document.head.appendChild(schema)}
   const baseGraph=[
    {"@type":"WebSite","@id":`${base}/#website`,url:base+"/",name:"Kivora",description:"Shorts-first entertainment discovery platform."},
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
     setTab(state?.kivora?.tab || (state?.tab && ["home","history","account","premium","ads","faqs","about","privacy","terms","disclaimer","creators","help"].includes(state.tab)) ? state.tab : "home");
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

 if(!signedIn){
  return <div className="authGate"><div className="authGlow"/><section className="authCard"><div className="authBrandMark">K</div><p className="authEyebrow">YOUR DAILY SHORTS FEED</p><h1>Less searching.<br/><span>More watching.</span></h1><p className="authCopy">A clean, fast stream of Shorts picked by category and ready when you are.</p><button className="googleLoginButton" onClick={google} disabled={busy||!authReady}><span className="googleG">G</span>{busy?"Connecting…":"Continue with Google"}<span className="googleArrow">→</span></button><small className="authFootnote">{!authReady?"Preparing secure sign-in…":"Choose your Google account to continue"}</small><div className="authPrivacy">By continuing, you agree to our <button onClick={()=>{window.location.hash="#terms"}}>Terms</button> and <button onClick={()=>{window.location.hash="#privacy"}}>Privacy Policy</button>.</div></section></div>;
 }
 return <div className="app">
  <header className={`topbar${barHidden&&!menu&&!categoryMenuOpen&&!searchOpen?" topbarHidden":""}`}>
   <button className="brand" onClick={()=>go("home")}><span className="brandGlyph"><BrandMark/></span><span>Kivora</span></button>
   <div className="topActions">
    <div className="categoryDropdown"><button className={`categoryTrigger ${categoryMenuOpen?"active":""}`} onClick={()=>setCategoryMenuOpen(v=>!v)} aria-expanded={categoryMenuOpen}><span className="categoryTriggerIcon"><Icon name="grid"/></span><span>CATEGORIES</span><span className="categoryCurrent">{categories.find(c=>c[0]===category)?.[1]||"For You"}</span><span className="categoryChevron"><Icon name="chevronDown" size={16}/></span></button>{categoryMenuOpen&&<div className="categoryMenu" role="listbox" aria-label="Choose a video category">{categories.map(([key,label])=><button key={key} role="option" aria-selected={category===key} className={category===key?"selected":""} onClick={()=>{setCategory(key);setQuery("");setShuffleOrder([]);setSearchOpen(false);setCategoryMenuOpen(false);go("home",{history:false});requestAnimationFrame(()=>document.querySelector(".feed")?.scrollTo({top:0,behavior:"auto"}))}}>{label}{category===key&&<span>✓</span>}</button>)}</div>}</div>
    <button className="headerIconButton" onClick={()=>{setSearchOpen(v=>!v);setCategoryMenuOpen(false);if(!searchOpen)setTimeout(()=>document.getElementById("kivora-inline-search")?.focus(),60);else setQuery("")}} aria-label={searchOpen?"Close search":"Search videos"} title="Search">{searchOpen?<Icon name="close"/>:<Icon name="search"/>}</button>
    <button className="headerIconButton refreshButton" onClick={refreshFeed} aria-label="Shuffle and refresh videos" title="Shuffle videos"><Icon name="refresh"/></button>
    <button className="menuBtn" aria-label="Open menu" onClick={()=>setMenu(!menu)}><Icon name="more"/></button>
    <button className="avatar accountAvatar" onClick={()=>go("account")} aria-label={`Account: ${user.email||"Google account"}`} title={user.email||"Google account"}>{user.photoURL?<img src={user.photoURL} alt=""/>:<span>{(user.email||"K").trim().slice(0,1).toUpperCase()}</span>}</button>
   </div>
   {searchOpen&&<form className="inlineSearchBar" onSubmit={e=>{e.preventDefault();go("home",{history:false});setSearchOpen(false)}}><span>⌕</span><input id="kivora-inline-search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search videos, titles, creators, channels…" aria-label="Search YouTube Shorts"/><button type="submit">Search</button><button type="button" className="searchCancel" onClick={()=>{setQuery("");setSearchOpen(false)}}>Cancel</button></form>}
   {menu&&<aside className="menuPanel">
    <div className="menuHead"><strong>Explore Kivora</strong><button className="iconBtn" onClick={()=>setMenu(false)}>×</button></div>
    <button onClick={()=>go("home")}>Discover</button><button onClick={()=>go("history")}>Watch history</button>
    <div className="menuLine"/>
    <details open><summary>Personalize</summary><div className="menuSub">
      <button onClick={()=>setTheme("light")}>☀ Light mode</button><button onClick={()=>setTheme("dark")}>☾ Dark mode</button><button onClick={()=>setTheme("system")}>◐ System mode</button>
      {installPrompt&&<button onClick={async()=>{installPrompt.prompt();await installPrompt.userChoice;setInstallPrompt(null)}}>＋ Install Kivora</button>}
    </div></details>
    <details><summary>More Kivora</summary><div className="menuSub"><button onClick={()=>go("premium")}>Kivora Pro</button><button onClick={()=>go("ads")}>Ads Studio</button></div></details>
    <details><summary>Help & FAQs</summary><div className="menuSub"><button onClick={()=>go("faqs")}>Frequently asked questions</button><button onClick={()=>go("help")}>Help & contact</button></div></details>
    <details><summary>Legal & policies</summary><div className="menuSub"><button onClick={()=>go("about")}>About Kivora</button><button onClick={()=>go("privacy")}>Privacy</button><button onClick={()=>go("terms")}>Terms</button><button onClick={()=>go("disclaimer")}>Disclaimer</button><button onClick={()=>go("creators")}>Creators & rights holders</button></div></details>
    <details><summary>YouTube</summary><div className="menuSub"><a href="https://www.youtube.com/" target="_blank" rel="noreferrer">Open YouTube ↗</a><span className="menuHint">Use YouTube directly for actions such as comments, subscriptions, channel management and other YouTube features.</span></div></details>
    {user&&<><div className="menuLine"/><button onClick={async()=>{await logOut();go("home");}}>Sign out</button></>}
   </aside>}
  </header>



  <main>
   {tab==="search"&&<section className="searchPage panel"><small>DISCOVER ON YOUTUBE</small><h1>Search Shorts</h1><p>Search YouTube Shorts by keyword, creator, topic or song. Choose a result to return to the vertical feed.</p><form onSubmit={e=>{e.preventDefault();go("home");setVideoLoading(true)}} className="searchPageForm"><input id="kivora-search-input" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Try comedy, coding, football…" aria-label="Search YouTube Shorts"/><button className="primary" type="submit">Search</button></form><div className="searchSuggestions">{["Comedy","Technology","Music","Football","Education","Gaming"].map(term=><button key={term} onClick={()=>{setQuery(term);go("home")}}>{term}</button>)}</div><p className="tiny">Results are discovered through the YouTube API. Search requests use your configured server quota.</p></section>}
   {tab==="home"&&<>
    {videoLoading&&!videos.length&&<div className="feedWarmup" aria-label="Preparing your feed"><span className="feedWarmupDot"/><span>Preparing your feed</span></div>}
    {videoError&&<section className="sourceNote"><b>Video discovery notice</b><p>{videoError}</p>{query.trim()&&<button onClick={()=>setQuery("")}>Back to Discover</button>}</section>}
    <div className="feed">{(()=>{
      const ranked=videos.filter(v=>{const r=ratings[v.id]||{};const item={...v,...r};return isEligibleShort(item)&&!isLikelySpam(item)&&(query.trim()?true:(!seenRef.current.has(v.id)&&canRecommend(item)));}).map(v=>{
        const r=ratings[v.id]||{};
        const viewerRating=effectiveOriginality(r.ratingAverage,r.ratingCount);
        const engagement=Number(v.engagementScore||0);
        const recScore=(viewerRating/5)*60 + Math.min(40,engagement*2.2);
        return {...v,recScore};
      });
      const seenVideoIds=new Set();
      const uniqueRanked=ranked.filter(v=>{const id=String(v.id||"");if(!id||seenVideoIds.has(id))return false;seenVideoIds.add(id);return true;});
      ranked.length=0;ranked.push(...uniqueRanked);
      if(shuffleOrder.length){const order=new Map(shuffleOrder.map((id,index)=>[id,index]));ranked.sort((a,b)=>(order.get(a.id)??Number.MAX_SAFE_INTEGER)-(order.get(b.id)??Number.MAX_SAFE_INTEGER));}
      else if(category==="new")ranked.sort((a,b)=>new Date(b.publishedAt||0)-new Date(a.publishedAt||0));
      else{
        // Stable per-session order: unseen videos first, quality-weighted but randomised each launch.
        // Ranks are assigned once per video, so late rating updates never reshuffle (or reload) cards.
        const ord=orderRef.current;let fresh=false;
        ranked.forEach(v=>{if(!ord.rank.has(v.id)){fresh=true;ord.rank.set(v.id,ord.batch*100000+(seenRef.current.has(v.id)?50000:0)+Math.random()*60-v.recScore)}});
        if(fresh)ord.batch++;
        ranked.sort((a,b)=>ord.rank.get(a.id)-ord.rank.get(b.id));
      }
      const cards=[];
      const eligibleSponsored=sponsored.filter((item,idx,arr)=>item.assetSource!=="drive"&&arr.findIndex(o=>o.id===item.id)===idx).sort((a,b)=>{const matches=item=>{const cats=Array.isArray(item.targetCategories)?item.targetCategories:["all"];return cats.includes("all")||category==="all"||cats.includes(category)};return Number(matches(b))-Number(matches(a));});
      const shownAdIds=new Set();
      ranked.forEach((v,i)=>{
        cards.push(<ShortsPlayer key={v.id} video={v} user={user} onOpen={openVideo} onNotice={setNotice} onNavigate={jumpVideo} audioConsent={audioConsent}/>);
        if(eligibleSponsored.length && (i+1)%8===0 && Math.floor(i/8)<eligibleSponsored.length){const ad=eligibleSponsored[Math.floor(i/8)];const adVideo={id:ad.assetSource==="drive"?ad.assetId:extractYouTubeId(ad.assetId||ad.youtubeUrl||""),source:ad.assetSource||"youtube",assetId:ad.assetId,title:ad.title||"Sponsored Short",channelTitle:ad.brand||"Advertiser",durationSeconds:Number(ad.durationSeconds||ad.duration||30),site:ad.site||"",destinationName:ad.destinationName||ad.brand||"",siteIcon:ad.siteIcon||"",promotionType:ad.promotionType||"short",};if(adVideo.id&&!seenVideoIds.has(adVideo.id)&&!shownAdIds.has(adVideo.id)){shownAdIds.add(adVideo.id);cards.push(<ShortsPlayer key={`ad-${ad.id}-${i}`} video={adVideo} user={user} onNotice={setNotice} onNavigate={jumpVideo} ad playbackKey={ad.id} campaignId={ad.id} audioConsent={audioConsent}/>);}}
      });
      if(!cards.length&&!videoLoading)cards.push(<section className="emptyState" key="empty"><h3>No videos to show</h3><p>Try another category or search term.</p></section>);
      return cards;
    })()}
    <div ref={feedSentinelRef} className="feedSentinel" aria-live="polite">{loadingMore&&<span className="feedSpinner" aria-label="Loading more videos"/>}{!loadingMore&&!hasMore&&videos.length>0&&<span>That’s all for now. Tap refresh to shuffle the feed.</span>}</div>
    </div>
   </>}
   {tab==="history"&&<HistoryPage user={user} onOpen={openFromHistory}/>}
   {tab==="watch"&&selectedVideo&&<VideoWatchPage video={selectedVideo} relatedVideos={videos} sponsored={sponsored} user={user} onNotice={setNotice} isPro={premium} onBack={()=>{if(window.history.length>1)window.history.back();else go("home")}} onOpenVideo={openFromHistory}/>}
   {tab==="account"&&<section className="panel"><h1>Your Kivora account</h1><p>{signedIn?"Google is connected. Your saved Kivora activity can sync across devices.":"You're using a guest session on this device."}</p>{!signedIn&&<button className="primary" onClick={google}>Connect Google</button>}</section>}
   {tab==="premium"&&<Premium user={user} onNotice={setNotice} owner={owner}/>}
   {tab==="ads"&&(signedIn?<AdStudio user={user} owner={owner}/>:<section className="panel"><h1>Advertise with Kivora</h1><p>Sign in with Google before creating a campaign.</p><button className="primary" onClick={google}>Continue with Google</button></section>)}
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
    playerVars:{autoplay:1,controls:1,rel:0,playsinline:1,enablejsapi:1,color:"white",cc_load_policy:captions?1:0,cc_lang_pref:captionLang,origin:publicOrigin()},
    events:{
      onReady:()=>{if(captions){try{player.current.loadModule("captions");player.current.setOption("captions","track",{language:captionLang});}catch{}}},
      onAutoplayBlocked:()=>{}
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


function extractDriveId(value=""){
 const s=String(value||"").trim();
 if(/^[A-Za-z0-9_-]{20,}$/.test(s)) return s;
 const m=s.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?id=)([A-Za-z0-9_-]+)/i);
 return m?.[1]||"";
}

const ICON_PATHS={
  grid:<><rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/></>,
  chevronDown:<path d="M6 9.5l6 6 6-6"/>,
  search:<><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></>,
  close:<path d="M6 6l12 12M18 6L6 18"/>,
  refresh:<><path d="M20 11a8 8 0 0 0-14.3-4.6L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4 13a8 8 0 0 0 14.3 4.6L20 15.5"/><path d="M20 20v-4.5h-4.5"/></>,
  more:<><circle cx="12" cy="5.5" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="18.5" r="1.4" fill="currentColor"/></>,
  arrowUp:<path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/>,
  arrowDown:<path d="M12 5v14M5.5 12.5L12 19l6.5-6.5"/>,
  play:<path d="M8 5.2v13.6a.6.6 0 0 0 .9.5l11-6.8a.6.6 0 0 0 0-1L8.9 4.7a.6.6 0 0 0-.9.5z" fill="currentColor" stroke="none"/>
};
function Icon({name,size=22}){return <svg className="kIcon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{ICON_PATHS[name]}</svg>}
function BrandMark(){return <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true"><path d="M9 6v20" stroke="#fff" strokeWidth="4.2" strokeLinecap="round"/><path d="M24 7.5L13.5 16l10.5 8.5" stroke="#fff" strokeWidth="4.2" strokeLinecap="round" strokeLinejoin="round" fill="none"/></svg>}
function ShortsPlayer({video,user,onOpen,onNotice,onNavigate,ad=false,playbackKey="",campaignId="",audioConsent=false}){
 const box=useRef(null),player=useRef(null),visibleRef=useRef(false),countedRef=useRef(false),impressionTimer=useRef(null),exposureKey=useRef(crypto.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`);
 const [ready,setReady]=useState(false),[playing,setPlaying]=useState(false),[started,setStarted]=useState(false),[visibleRatio,setVisibleRatio]=useState(0),[youtubeStats,setYoutubeStats]=useState(null);
 const [quickMenuOpen,setQuickMenuOpen]=useState(false),[descriptionOpen,setDescriptionOpen]=useState(false);
 const ytHost=useRef(null),prewarmRef=useRef(false),mutedByWarm=useRef(false),dwellTimer=useRef(null),userRef=useRef(user);userRef.current=user;
 const [warming,setWarming]=useState(false);
 useEffect(()=>{
   if(!ad||video.source==="drive"||!video.id)return;
   let cancelled=false;
   fetch(apiUrl(`/api/youtube-search?videoId=${encodeURIComponent(video.id)}`),{headers:{Accept:"application/json"}})
    .then(r=>r.ok?r.json():null)
    .then(data=>{if(cancelled)return;const item=data?.items?.[0];if(item)setYoutubeStats({viewCount:Number(item.statistics?.viewCount||0),youtubeLikeCount:Number(item.statistics?.likeCount||0),commentCount:Number(item.statistics?.commentCount||0)});})
    .catch(()=>{});
   return()=>{cancelled=true};
 },[ad,video.id,video.source]);
 const engagement= youtubeStats||video;
 const driveId=video.source==="drive"?video.id:extractDriveId(video.assetId||"");
 const isDrive=Boolean(driveId);
 const playbackMode=ad?"sponsored":"organic";
 const id=`yt-short-${String(video.id).replace(/[^A-Za-z0-9_-]/g,"")}-${playbackKey||playbackMode}`;

 async function reportQualifiedImpression(){
   if(!ad||!campaignId||countedRef.current)return;
   const u=auth.currentUser;
   countedRef.current=true;
   try{
     const headers={'Content-Type':'application/json'};
     if(u&&!u.isAnonymous) headers.Authorization=`Bearer ${await u.getIdToken()}`;
     const res=await fetch(apiUrl('/api/ad-impression'),{method:'POST',headers,body:JSON.stringify({campaignId,impressionKey:`${campaignId}-${exposureKey.current}`,viewerKey:`${u?.uid||'anonymous'}-${exposureKey.current}`,secondsViewed:2,visibleRatio:Math.max(.5,visibleRatio),source:isDrive?'drive':'youtube'})});
     if(!res.ok){countedRef.current=false;return;}
   }catch{countedRef.current=false;}
 }
 function armImpression(){
   if(!ad||!campaignId||countedRef.current||impressionTimer.current)return;
   impressionTimer.current=setTimeout(()=>{impressionTimer.current=null;if(visibleRef.current&&(isDrive||playing))reportQualifiedImpression()},2000);
 }
 function disarmImpression(){if(impressionTimer.current){clearTimeout(impressionTimer.current);impressionTimer.current=null}}

 useEffect(()=>{
   let cancelled=false;
   if(isDrive){setReady(true);return()=>{cancelled=true;disarmImpression()};}
   const destroyPlayer=()=>{
     prewarmRef.current=false;mutedByWarm.current=false;
     try{player.current?.destroy()}catch{}
     player.current=null;
     if(ytHost.current)ytHost.current.innerHTML="";
     setReady(false);setPlaying(false);setStarted(false);setWarming(false);
   };
   const start=()=>{
     if(cancelled||player.current||!window.YT?.Player||!ytHost.current)return;
     const holder=document.createElement("div");
     ytHost.current.appendChild(holder);
     player.current=new window.YT.Player(holder,{videoId:video.id,width:"100%",height:"100%",playerVars:{autoplay:visibleRef.current?1:0,mute:0,controls:0,rel:0,playsinline:1,enablejsapi:1,iv_load_policy:3,disablekb:1,fs:0,origin:publicOrigin()},events:{
       onReady:()=>{
         if(cancelled)return;
         setReady(true);
         try{
           if(visibleRef.current){if(audioConsent){player.current.unMute()}player.current.playVideo();setPlaying(true)}
           // Neighbouring Short: buffer it silently now (muted), pause as soon as it starts, so it begins instantly when scrolled to.
           else{prewarmRef.current=true;mutedByWarm.current=true;setWarming(true);player.current.mute();player.current.playVideo()}
         }catch{}
       },
       onStateChange:e=>{
         const S=window.YT?.PlayerState;if(!S)return;
         if(e.data===S.PLAYING){
           if(prewarmRef.current&&!visibleRef.current){prewarmRef.current=false;try{player.current?.pauseVideo()}catch{}return;}
           setPlaying(true);setStarted(true);armImpression();
         }
         if([S.PAUSED,S.ENDED].includes(e.data)){setPlaying(false);disarmImpression()}
       },
       onAutoplayBlocked:()=>{},
       onError:e=>{setPlaying(false);onNotice?.(e?.data===101||e?.data===150?"This creator has disabled embedded playback for this video.":e?.data===153?"YouTube could not verify the embed request. Check the deployment domain and player origin.":"YouTube could not play this Short. It may be unavailable, restricted, or the connection was interrupted.")}
     }});
   };
   // Players are created for the Shorts right next to the one on screen (rooted at the scrolling .feed),
   // and torn down once they are more than ~2 screens away so phones do not accumulate heavy iframes.
   let nearObserver,farObserver;
   loadYouTubeApi(()=>{
     if(cancelled)return;
     const target=box.current;
     if(!target){start();return;}
     const root=target.closest(".feed")||null;
     nearObserver=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))start()},{root,rootMargin:"90% 0px",threshold:0});
     farObserver=new IntersectionObserver(entries=>{const last=entries[entries.length-1];if(last&&!last.isIntersecting&&player.current)destroyPlayer()},{root,rootMargin:"220% 0px",threshold:0});
     nearObserver.observe(target);farObserver.observe(target);
   });
   return()=>{cancelled=true;nearObserver?.disconnect();farObserver?.disconnect();disarmImpression();try{player.current?.destroy()}catch{}player.current=null};
 },[video.id,id,isDrive,campaignId,audioConsent]);

 useEffect(()=>{
   const node=box.current;if(!node)return;
   const observer=new IntersectionObserver(entries=>{
     const entry=entries[0];if(!entry)return;
     const ratio=Number(entry.intersectionRatio||0);setVisibleRatio(ratio);
     const active=entry.isIntersecting&&ratio>=.55;visibleRef.current=active;
     if(!ad){
       if(active){if(!dwellTimer.current)dwellTimer.current=setTimeout(()=>{dwellTimer.current=null;recordWatch(userRef.current?.uid,video)},1500)}
       else if(dwellTimer.current){clearTimeout(dwellTimer.current);dwellTimer.current=null}
     }
     if(!player.current||!ready){if(active&&isDrive)armImpression();else if(!active)disarmImpression();return;}
     try{if(active){prewarmRef.current=false;setWarming(false);const needUnmute=audioConsent||mutedByWarm.current;mutedByWarm.current=false;if(needUnmute)player.current.unMute();player.current.playVideo();setPlaying(true);armImpression()}else{player.current.pauseVideo();setPlaying(false);disarmImpression()}}catch{}
   },{threshold:[0,.5,.72,.9],rootMargin:'0px'});
   observer.observe(node);return()=>{observer.disconnect();disarmImpression();if(dwellTimer.current){clearTimeout(dwellTimer.current);dwellTimer.current=null}};
 },[ready,isDrive,audioConsent]);

 const embed= isDrive ? `https://drive.google.com/file/d/${encodeURIComponent(driveId)}/preview?autoplay=1` : "";
 return <article className={`shortCard ${ad?"shortAdCard":""}`} ref={box}>
   <div className="shortPlayer">
     {isDrive?<iframe className="shortYT shortDriveFrame" src={embed} title={video.title||"Sponsored video"} allow="autoplay; fullscreen" allowFullScreen onLoad={()=>{setReady(true);if(visibleRef.current)armImpression()}}/>:<div ref={ytHost} className="shortYT"/>}
     {!isDrive&&!started&&<img className="shortPoster" src={video.thumb||`https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`} alt="" decoding="async" loading="lazy" draggable="false" onError={e=>{e.currentTarget.style.display="none"}}/>}
     {!isDrive&&ready&&!playing&&!warming&&<button className="shortPlaybackFallback" onClick={e=>{e.stopPropagation();try{player.current?.playVideo();player.current?.unMute();setPlaying(true)}catch{onNotice?.("YouTube player is not ready. Check your connection and try again.")}}} aria-label="Play Short"><Icon name="play" size={20}/> <span>Tap to play</span></button>}
     {ad&&<div className="shortTopline"><span>SPONSORED</span></div>}
     <div className="shortGradient" aria-hidden="true"/>
     <div className="shortRail shortNavigationRail" onClick={e=>e.stopPropagation()}><button className="shortRailButton" onClick={()=>onNavigate?.(-1)} aria-label="Previous Short" title="Previous Short"><span><Icon name="arrowUp" size={22}/></span></button><button className="shortRailButton" onClick={()=>onNavigate?.(1)} aria-label="Next Short" title="Next Short"><span><Icon name="arrowDown" size={22}/></span></button><button className="shortRailButton shortMoreButton" onClick={()=>setQuickMenuOpen(v=>!v)} aria-label="More options" title="More options"><span><Icon name="more" size={22}/></span></button>{quickMenuOpen&&<><button className="quickMenuDismiss" aria-label="Close menu" onClick={()=>setQuickMenuOpen(false)}></button><div className="shortQuickMenu" role="menu">{[["ads","Ads Studio"],["settings","Settings"],["history","Watch history"],["about","About Kivora"],["privacy","Privacy policy"],["terms","Terms of service"],["creators","Creators & rights holders"],["signout","Sign out"]].map(([action,label])=><button key={action} role="menuitem" onClick={()=>{setQuickMenuOpen(false);window.dispatchEvent(new CustomEvent("kivora:quick-menu",{detail:action}));}}>{label}</button>)}</div></>}</div>
     <div className="shortBottomInfo" onClick={e=>e.stopPropagation()}><div className="shortCreator"><span className="shortAvatar">{(video.channelTitle||"Y").slice(0,1).toUpperCase()}</span><b>{video.channelTitle||"YouTube"}</b></div><h2>{video.title}</h2><p className="shortDescriptionPreview">{video.desc?`${video.desc.slice(0,20)}${video.desc.length>20?"…":""}`:""}{video.desc?.length>20&&<button className="descriptionMore" onClick={()=>setDescriptionOpen(true)}>more</button>}</p>{ad&&<div className="shortAdMeta"><span>Sponsored · Kivora</span>{isDrive?<small>Hosted by Google Drive</small>:<small>Provided by YouTube</small>}</div>}</div>
     {descriptionOpen&&<div className="shortDescriptionBackdrop" onClick={()=>setDescriptionOpen(false)}><section className="shortDescriptionSheet" role="dialog" aria-modal="true" aria-label="Video description" onClick={e=>e.stopPropagation()}><header><b>Video description</b><button onClick={()=>setDescriptionOpen(false)} aria-label="Close description">×</button></header><h3>{video.title}</h3><p>{video.desc||"No description provided."}</p><small>{video.channelTitle||"YouTube"}</small></section></div>}
   </div>
   {ad&&(video.promotionType==="app"&&video.site||video.promotionType!=="app")&&<a className="shortDestinationBanner" href={video.promotionType==="app"?video.site:youtubeShortUrl(video.id)} target="_blank" rel="noopener noreferrer" onClick={()=>{try{navigator.sendBeacon?.(apiUrl('/api/ad-click'),new Blob([JSON.stringify({campaignId,placement:video.promotionType==="app"?"shorts-site-banner":"shorts-youtube-banner"})],{type:'application/json'}))}catch{}}}><span className="destinationIcon"><img src={video.promotionType==="app"?(video.siteIcon||`https://www.google.com/s2/favicons?domain=${encodeURIComponent(video.site)}&sz=128`):"https://www.youtube.com/s/desktop/ee47a3d6/img/favicon_144x144.png"} alt="" onError={e=>{e.currentTarget.style.display="none"}}/></span><span className="destinationCopy"><b>{video.promotionType==="app"?(video.destinationName||video.channelTitle||"Visit advertiser"):(video.channelTitle||"Watch on YouTube")}</b><small>{video.promotionType==="app"?video.site.replace(/^https?:\/\//i,"").replace(/\/$/,""):`youtube.com/shorts/${video.id}`}</small></span><strong>{video.promotionType==="app"?"Visit ↗":"Watch ↗"}</strong></a>}
 </article>
}
function VideoWatchPage({video,relatedVideos,sponsored,user,onNotice,isPro,onBack,onOpenVideo}){
 const related=relatedVideos.filter(v=>v.id!==video.id&&!isLikelySpam(v)).slice(0,10);
 const [liked,setLiked]=useState(false),[likes,setLikes]=useState(0),[saved,setSaved]=useState(false);
 useEffect(()=>{if(!user)return;setLiked(localStorage.getItem(`kivora-like-${video.id}-${user.uid}`)==="1");},[user,video.id]);
 async function runYouTubeAction(action){
   if(!user||user.isAnonymous){onNotice("Sign in with Google before interacting with YouTube.");return;}
   try{
     const accessToken=await getYouTubeAccessToken();
     const idToken=await user.getIdToken();
     const response=await fetch(apiUrl("/api/youtube-actions"),{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${idToken}`},body:JSON.stringify({videoId:video.id,action,accessToken})});
     const data=await response.json().catch(()=>({}));
     if(!response.ok)throw new Error(data.error||"YouTube action failed.");
     if(action==="like"){setLiked(data.rating==="like");onNotice(data.rating==="like"?"Liked on YouTube.":"Like removed on YouTube.");}
     if(action==="save"){setSaved(Boolean(data.saved));onNotice(data.saved?"Saved to your private YouTube playlist.":"Removed from your private YouTube playlist.");}
   }catch(e){onNotice(e?.message||"YouTube action failed.")}
 }
 async function like(){await runYouTubeAction("like")}
 async function save(){await runYouTubeAction("save")}
 async function share(){const url=`${publicOrigin()}/?watch=${encodeURIComponent(video.id)}`;try{if(navigator.share){await navigator.share({title:video.title,url});return}if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(url);onNotice("Kivora link copied.");return}throw new Error()}catch(e){if(e?.name!=="AbortError")onNotice("Copy the page link to share.")}}
 return <section className="watchPage">
   <div className="watchTop"><button className="backBtn" onClick={onBack}>← Back to FYP</button><span className="watchSource">Organic video · YouTube player</span></div>
   <YouTubePlayer video={video} isPro={isPro} onNotice={onNotice}/>
   <article className="watchInfo">
    <div className="videoMetaLine"><div className="eyebrow">{video.lang}</div></div>
    <h1>{video.title}</h1>
    <div className="watchChannel"><span className="channelAvatar large">{(video.channelTitle||"Y").slice(0,1).toUpperCase()}</span><div><b>{video.channelTitle||"YouTube"}</b><span>{Number(video.viewCount||0).toLocaleString()} views{video.publishedAt?` · ${new Date(video.publishedAt).toLocaleDateString()}`:""}</span></div></div>

    <details className="watchDescription" open><summary>About this video</summary><p>{video.desc}</p><span>{Number(video.youtubeLikeCount||0).toLocaleString()} YouTube likes · {Number(video.commentCount||0).toLocaleString()} comments · {video.hasCaptions?"Captions available":"Captions not indicated"}</span></details>
   </article>
   <div className="relatedSection">
    <div className="relatedHeading"><div><small>UP NEXT</small><h2>Related Shorts</h2></div><span>{related.length} videos</span></div>
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

const HISTORY_CAP=100,SEEN_CAP=10000;
function historyKey(uid){return `kivora-history-v1:${uid||"guest"}`}
function readHistory(uid){try{const a=JSON.parse(localStorage.getItem(historyKey(uid))||"[]");return Array.isArray(a)?a:[]}catch{return[]}}
function readSeen(){try{return new Set(JSON.parse(localStorage.getItem("kivora-seen-v1")||"[]"))}catch{return new Set()}}
function markSeen(id){try{const arr=JSON.parse(localStorage.getItem("kivora-seen-v1")||"[]");if(!arr.includes(id)){arr.push(id);localStorage.setItem("kivora-seen-v1",JSON.stringify(arr.slice(-SEEN_CAP)));window.dispatchEvent(new CustomEvent("kivora:seen",{detail:id}))}}catch{}}
// Called once a Short has been on screen long enough to count as watched. Stored on this device (localStorage).
function recordWatch(uid,video){
 if(!video?.id)return;
 try{
  const list=readHistory(uid).filter(x=>x.id!==video.id);
  list.unshift({id:video.id,title:video.title||"",channelTitle:video.channelTitle||"",thumb:video.thumb||`https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,desc:String(video.desc||"").slice(0,400),publishedAt:video.publishedAt||"",viewCount:Number(video.viewCount||0),at:Date.now()});
  localStorage.setItem(historyKey(uid),JSON.stringify(list.slice(0,HISTORY_CAP)));
 }catch{}
 markSeen(video.id);
}
function HistoryPage({user,onOpen}){
 const [items,setItems]=useState(()=>readHistory(user?.uid));
 const ago=t=>{const m=Math.max(1,Math.round((Date.now()-Number(t||0))/60000));if(m<60)return `${m} min ago`;const h=Math.round(m/60);if(h<24)return `${h} h ago`;return `${Math.round(h/24)} d ago`};
 return <section className="panel"><h1>Watch history</h1>{!items.length?<p>Videos you watch will appear here, newest first. History is kept on this device.</p>:<><button onClick={()=>{try{localStorage.removeItem(historyKey(user?.uid))}catch{}setItems([])}}>Clear history</button>{items.map(v=><div className="savedItem historyItem" key={v.id} role="button" tabIndex={0} onClick={()=>onOpen(v)} onKeyDown={e=>{if(e.key==="Enter")onOpen(v)}}><img src={v.thumb} alt="" loading="lazy"/><div><b>{v.title}</b><p>{v.channelTitle} · {ago(v.at)}</p></div></div>)}</>}</section>
}

function ConfirmModal({title,message,yes="Yes",no="No",busy,onYes,onNo}){
 return <div className="confirmBack" role="dialog" aria-modal="true"><div className="confirmBox"><h2>{title}</h2><p>{message}</p><div className="confirmBtns"><button type="button" disabled={busy} onClick={onNo}>{no}</button><button type="button" className="dangerBtn" disabled={busy} onClick={onYes}>{busy?"Please wait…":yes}</button></div></div></div>;
}

function CardPayment({campaignId,amountNgn,onPaid,onBack,onCancel}){
 const [stage,setStage]=useState("card"),[busy,setBusy]=useState(false),[msg,setMsg]=useState("");
 const [number,setNumber]=useState(""),[exp,setExp]=useState(""),[cvv,setCvv]=useState(""),[pin,setPin]=useState(""),[otp,setOtp]=useState("");
 async function call(action,body){
  const r=await authedFetch(apiUrl(`/api/ad-campaign?action=${action}`),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({campaignId,...body})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d.error||"Payment could not be completed.");
  return d;
 }
 function handle(d){
  if(d.step==="success"){setNumber("");setExp("");setCvv("");setPin("");setOtp("");onPaid();return}
  if(d.step==="pin"){setStage("pin");setMsg("Enter your 4-digit card PIN.");return}
  if(d.step==="otp"){setStage("otp");setMsg(d.message||"Enter the OTP your bank sent you.");return}
  if(d.step==="redirect"&&d.redirectUrl){setMsg("Opening your bank's secure verification page…");openExternal(d.redirectUrl);return}
  if(d.step==="failed"){setStage("card");setPin("");setOtp("");setMsg(d.message||"Payment failed. Check your card details and try again.");return}
  setMsg(d.message||"Waiting for your bank to confirm the payment. Tap Check payment status in a moment.");
 }
 async function run(fn){
  if(busy)return;setBusy(true);setMsg("");
  try{handle(await fn())}catch(e){setMsg(e?.message||"Payment could not be completed.")}finally{setBusy(false)}
 }
 const [mm,yy]=exp.split("/");
 const payCard=()=>run(()=>call("pay",{card:{number,expMonth:mm||"",expYear:yy||"",cvv}}).then(d=>{setCvv("");return d}));
 const sendPin=()=>run(()=>call("authorize",{type:"pin",pin}).then(d=>{setPin("");return d}));
 const sendOtp=()=>run(()=>call("authorize",{type:"otp",code:otp}));
 const check=()=>run(async()=>{const r=await authedFetch(apiUrl("/api/ad-campaign?action=verify"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({campaignId})});const d=await r.json().catch(()=>({}));if(r.ok&&d.verified)return {step:"success"};return {step:"pending",message:d.error||"Payment is still pending."}});
 return <section className="panel cardPay"><button onClick={onBack} disabled={busy}>← Back to review</button><h1>Pay with card</h1>
  <p>Amount due: <b>₦{Number(amountNgn||0).toLocaleString()}</b>. Your card details go straight to Flutterwave over an encrypted connection; Kivora never stores them.</p>
  {stage==="card"&&<div className="cardForm">
   <label>Card number<input inputMode="numeric" autoComplete="cc-number" placeholder="0000 0000 0000 0000" value={number} maxLength={23} onChange={e=>setNumber(e.target.value.replace(/\D/g,"").slice(0,19).replace(/(.{4})/g,"$1 ").trim())}/></label>
   <div className="cardRow"><label>Expiry (MM/YY)<input inputMode="numeric" autoComplete="cc-exp" placeholder="MM/YY" value={exp} maxLength={5} onChange={e=>{let v=e.target.value.replace(/\D/g,"").slice(0,4);if(v.length>2)v=v.slice(0,2)+"/"+v.slice(2);setExp(v)}}/></label>
   <label>CVV<input inputMode="numeric" autoComplete="cc-csc" type="password" placeholder="•••" value={cvv} maxLength={4} onChange={e=>setCvv(e.target.value.replace(/\D/g,"").slice(0,4))}/></label></div>
   <button className="primary" disabled={busy||number.replace(/\s/g,"").length<12||exp.length<5||cvv.length<3} onClick={payCard}>{busy?"Processing…":`Pay ₦${Number(amountNgn||0).toLocaleString()}`}</button></div>}
  {stage==="pin"&&<div className="cardForm"><label>Card PIN<input inputMode="numeric" type="password" autoComplete="off" placeholder="••••" value={pin} maxLength={4} onChange={e=>setPin(e.target.value.replace(/\D/g,"").slice(0,4))}/></label>
   <button className="primary" disabled={busy||pin.length!==4} onClick={sendPin}>{busy?"Verifying…":"Submit PIN"}</button></div>}
  {stage==="otp"&&<div className="cardForm"><label>One-time password (OTP)<input inputMode="numeric" autoComplete="one-time-code" placeholder="Enter OTP" value={otp} maxLength={10} onChange={e=>setOtp(e.target.value.replace(/\D/g,"").slice(0,10))}/></label>
   <button className="primary" disabled={busy||otp.length<4} onClick={sendOtp}>{busy?"Verifying…":"Submit OTP"}</button></div>}
  {msg&&<div className="status">{msg}</div>}
  <button disabled={busy} onClick={check}>Check payment status</button>
  <button type="button" className="dangerBtn" disabled={busy} onClick={onCancel}>Cancel campaign</button>
 </section>;
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
  "Ad-reduced Kivora browsing experience",
  "Full-screen and landscape playback controls",
  "Faster access to related action-movie recommendations",
  "Future Pro-only Kivora features as they are released"
 ];
 return <section className="panel pro"><small>KIVORA PRO</small><h1>More control over your movie experience.</h1><p><b>Pro features are listed clearly before payment.</b> Subtitle behavior still depends on what YouTube makes available for each source video. Kivora does not download or re-host the video's captions.</p><div className="proPriceBox"><b>Pro access</b><span>USD price is configured server-side with a Naira equivalent shown before checkout.</span><span>Payment is verified server-side through Flutterwave before Pro is granted.</span></div><div className="proBenefits"><h2>What you get with Pro</h2><ul>{benefits.map(x=><li key={x}><span className="proCheck">✓</span><span>{x}</span></li>)}</ul></div><div className="proGrid"><div><b>Free</b><span>Core discovery, FYP, related videos, saved-video basics and standard YouTube playback.</span></div><div><b>Pro</b><span>Expanded Kivora convenience features, caption-language controls and reduced Kivora advertising.</span></div></div><button className="primary" onClick={checkout} disabled={loading}>{loading?"Opening…":owner?"Pro enabled for owner":"Continue to secure checkout"}</button><p className="tiny">{owner?"Owner billing bypass is enabled for the configured Kivora owner account.":"No client-side paid flag unlocks Pro. The server must verify payment first."}</p></section>
}

function AdStudio({user,owner=false}){
 const [step,setStep]=useState("prep"),[status,setStatus]=useState(""),[submitting,setSubmitting]=useState(false),[confirmCfg,setConfirmCfg]=useState(null),[campaignId,setCampaignId]=useState(""),[amountDue,setAmountDue]=useState(0),[myCampaigns,setMyCampaigns]=useState([]),[loadingCampaigns,setLoadingCampaigns]=useState(false);
 const today=(()=>{const n=new Date();return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-${String(n.getDate()).padStart(2,"0")}`})();
 const [form,setForm]=useState({promotionType:"short",brand:"",title:"",description:"",assetId:"",site:"",destinationName:"",siteIcon:"",country:"",categories:["all"],targetLocation:"all",targetImpressions:"3000",duration:"1",startDate:today});
 const update=(k,v)=>setForm(x=>({...x,[k]:v}));
 // Keep the in-progress ad form in localStorage so advertisers can leave and continue later.
 const draftKey=`kivora-ad-draft-${user?.uid||"anon"}`;
 const [draftLoaded,setDraftLoaded]=useState(false),[draftRestored,setDraftRestored]=useState(false);
 useEffect(()=>{
  setDraftLoaded(false);
  try{
   const saved=JSON.parse(localStorage.getItem(draftKey)||"null");
   if(saved&&saved.form){
    const f={...saved.form};
    if(!/^\d{4}-\d{2}-\d{2}$/.test(f.startDate||"")||f.startDate<today)f.startDate=today;
    setForm(x=>({...x,...f}));
    setStep(saved.step==="form"||saved.step==="review"?saved.step:"prep");
    setDraftRestored(true);
   }
  }catch{}
  setDraftLoaded(true);
 },[draftKey]);
 useEffect(()=>{
  if(!draftLoaded)return;
  const t=setTimeout(()=>{try{
   const touched=["brand","title","description","assetId","site","destinationName","siteIcon"].some(k=>String(form[k]||"").trim());
   if(touched)localStorage.setItem(draftKey,JSON.stringify({form,step:step==="prep"?"prep":step,savedAt:Date.now()}));
  }catch{}},350);
  return()=>clearTimeout(t);
 },[form,step,draftLoaded,draftKey]);
 function clearDraft(){try{localStorage.removeItem(draftKey)}catch{};setDraftRestored(false)}
 function resetDraft(){clearDraft();setForm({promotionType:"short",brand:"",title:"",description:"",assetId:"",site:"",destinationName:"",siteIcon:"",country:"",categories:["all"],targetLocation:"all",targetImpressions:"3000",duration:"1",startDate:today});setStep("form");setStatus("")}
 async function pickIcon(e){
  const file=e.target.files?.[0];e.target.value="";
  if(!file)return;
  if(!/^image\/(png|jpeg|webp|gif)$/.test(file.type)){setStatus("Choose a PNG, JPG or WebP image for the app icon.");return}
  if(file.size>8*1024*1024){setStatus("That image is too large. Choose one under 8 MB.");return}
  try{
   const url=URL.createObjectURL(file);
   const img=await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=url});
   const size=128,canvas=document.createElement("canvas");canvas.width=canvas.height=size;
   const ctx=canvas.getContext("2d");
   const side=Math.min(img.naturalWidth,img.naturalHeight),sx=(img.naturalWidth-side)/2,sy=(img.naturalHeight-side)/2;
   ctx.drawImage(img,sx,sy,side,side,0,0,size,size);URL.revokeObjectURL(url);
   let data=canvas.toDataURL("image/webp",0.85);
   if(!data.startsWith("data:image/webp"))data=canvas.toDataURL("image/png");
   if(data.length>55000)data=canvas.toDataURL("image/jpeg",0.8);
   update("siteIcon",data);setStatus("");
  }catch{setStatus("That image could not be read. Try another one.")}
 }
 function cancelCampaign(id){
  if(!id)return;
  setConfirmCfg({title:"Cancel this campaign?",message:"Delivery stops immediately. Impressions already delivered are not refunded automatically.",yes:"Yes, cancel",no:"No, keep it",onYes:async()=>{setConfirmCfg(null);await doCancelCampaign(id)}});
 }
 function clearUnpaid(){
  const n=myCampaigns.filter(c=>c.status==="pending_payment").length;
  if(!n)return;
  setConfirmCfg({title:`Remove ${n} unpaid campaign${n>1?"s":""}?`,message:"These were never paid for and have not delivered anything. Paid and running campaigns are not touched.",yes:"Yes, remove",no:"No",onYes:async()=>{setConfirmCfg(null);setStatus("Removing unpaid campaigns…");try{const r=await authedFetch(apiUrl("/api/ad-campaign?action=cancel-unpaid"),{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Could not remove unpaid campaigns.");const gone=new Set(d.cancelled||[]);setMyCampaigns(list=>list.map(c=>gone.has(c.id)?{...c,status:"cancelled"}:c));if(gone.has(campaignId)){setCampaignId("");setAmountDue(0)}setStatus(`${gone.size} unpaid campaign${gone.size===1?"":"s"} removed.`);refreshCampaigns()}catch(e){setStatus(e?.message||"Could not remove unpaid campaigns.")}}});
 }
 async function doCancelCampaign(id){
  setStatus("Cancelling campaign…");
  try{
   const r=await authedFetch(apiUrl("/api/ad-campaign?action=cancel"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({campaignId:id})});
   const d=await r.json().catch(()=>({}));
   if(!r.ok)throw new Error(d.error||"Campaign could not be cancelled.");
   setMyCampaigns(list=>list.map(c=>c.id===id?{...c,status:"cancelled"}:c));
   if(id===campaignId)setCampaignId("");
   setStatus("Campaign cancelled. Delivery has stopped.");
   refreshCampaigns();
  }catch(e){setStatus(e?.message||"Campaign could not be cancelled.")}
 }
 const IMPRESSION_BLOCK=3000, MIN_CAMPAIGN_IMPRESSIONS=3000, VIDEO_PRICE_PER_BLOCK=1.00;
 const days=Math.max(1,Math.min(90,Number(form.duration)||1));
 const targetImpressions=Math.max(0,Math.floor(Number(String(form.targetImpressions).replace(/[^0-9]/g,""))||0));
 const billableBlocks=targetImpressions>0?Math.ceil(targetImpressions/IMPRESSION_BLOCK):0;
 const billableImpressions=billableBlocks*IMPRESSION_BLOCK;
 const estimatedBill=owner?0:Number((billableBlocks*VIDEO_PRICE_PER_BLOCK).toFixed(2));
 const dailyImpressions=days?Math.ceil(billableImpressions/days):0;
 const dailyBudget=days?Number((estimatedBill/days).toFixed(2)):0;
 const startDate=form.startDate||today;
 const endDate=(()=>{const d=new Date(`${startDate}T00:00:00Z`);if(Number.isNaN(d.getTime()))return startDate;d.setUTCDate(d.getUTCDate()+days-1);return d.toISOString().slice(0,10)})();
 const destinationRequired=form.promotionType==="app";
 async function refreshCampaigns(){
  if(!user||user.isAnonymous)return;
  setLoadingCampaigns(true);
  try{const snap=await getDocs(fsQuery(collection(db,"campaigns"),where("advertiserId","==",user.uid),limit(20)));setMyCampaigns(snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||""))))}catch{setMyCampaigns([])}finally{setLoadingCampaigns(false)}
 }
 useEffect(()=>{refreshCampaigns()},[user?.uid]);
 function preflight(){
  const text=Object.values(form).join(" ").toLowerCase();
  const political=["vote","election","candidate","political party","campaign","ballot","president","governor","senator","politician","electoral"].some(x=>text.includes(x));
  const adult=["porn","pornography","xxx","escort","onlyfans","nude","nudes","adult content"].some(x=>text.includes(x));
  if(political)return "Rejected: political advertising is not permitted.";
  if(adult)return "Rejected: adult/sexually explicit advertising is not permitted.";
  if(!form.brand.trim()||!form.title.trim())return "Rejected: brand and campaign title are required.";
  if(destinationRequired && !/^https?:\/\//i.test(form.site.trim()))return "Rejected: app/site promotion requires a valid destination URL.";
  if(destinationRequired && !form.destinationName.trim())return "Rejected: add the app/site name shown on the destination banner.";
  if(targetImpressions<MIN_CAMPAIGN_IMPRESSIONS)return "Rejected: enter at least 3,000 target impressions.";
  if(targetImpressions>100000000)return "Rejected: target impressions cannot exceed 100,000,000.";
  if(!days||days>90)return "Rejected: campaign duration must be 1–90 days.";
  if(!/^\d{4}-\d{2}-\d{2}$/.test(startDate))return "Rejected: choose a valid start date.";
  if(!/^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)[A-Za-z0-9_-]{6,}/i.test(form.assetId.trim()))return "Rejected: only a video already published on YouTube is accepted. Paste its YouTube URL or Shorts URL.";
  return "PASS";
 }
 async function submit(e){
  e.preventDefault();if(submitting)return;setSubmitting(true);setStatus("");
  const result=preflight();
  if(result!=="PASS"){setStatus(result);setSubmitting(false);return;}
  setStatus(`Preflight passed. ${owner?"Owner billing bypass applies. No payment is required.":"Estimated bill: "+moneyUsdNgn(estimatedBill)+" for "+billableImpressions.toLocaleString()+" qualified video impressions ("+billableBlocks+" × 3,000 at "+moneyUsdNgn(VIDEO_PRICE_PER_BLOCK)+")."} Pacing target: about ${dailyImpressions.toLocaleString()} qualified impressions/day and ${moneyUsdNgn(dailyBudget)}/day.`);
  setStep("review");setSubmitting(false);
 }
 const confirmEl=confirmCfg?<ConfirmModal {...confirmCfg} onNo={()=>setConfirmCfg(null)}/>:null;
 if(step==="prep")return <section className="panel">{confirmEl}<h1>Advertise with Kivora</h1><p>Kivora uses a video-only Shorts advertising system. Choose whether you are simply promoting a Short or sending viewers to an app/site.</p><div className="steps"><div><b>1. Publish first</b> — upload your video to YouTube, set its visibility so it can be embedded, and copy the public YouTube Shorts/video URL. Kivora never accepts an uploaded video file.</div><div><b>2. Choose your promotion</b> — promote the Short alone, or promote an app/site with an HTTPS destination URL and a name/logo banner beneath the video.</div><div><b>3. Review and pay</b> — Kivora verifies the YouTube video, vertical/square format, duration and embed permission before checkout. Payment is confirmed on the server before delivery.</div><div><b>4. Track delivery</b> — qualified impressions are counted server-side after at least 2 seconds with 50%+ visibility. Clicks, spend and pacing are tracked separately from YouTube engagement.</div><div><b>Important</b> — this is Kivora placement, not a YouTube Ads campaign or a guarantee of views. YouTube controls the player, availability, and its own engagement counts.</div></div><div className="priceBox"><b>{moneyUsdNgn(VIDEO_PRICE_PER_BLOCK)} / up to 3,000 qualified impressions</b><span>Minimum campaign: 3,000 qualified impressions. Pricing: $1 (₦1,300) per 3,000 target impressions; larger targets are billed in 3,000-impression blocks. Actual delivery depends on eligible viewers and placement availability.</span><span>One qualified impression requires at least 2 seconds at 50%+ visibility.</span></div><button className="primary" onClick={()=>setStep("form")}>{draftRestored?"Continue your draft campaign":"Create video campaign"}</button><div className="campaignList"><div className="relatedHeading"><div><small>MY CAMPAIGNS</small><h2>Expense monitor</h2></div><button onClick={refreshCampaigns} disabled={loadingCampaigns}>{loadingCampaigns?"Refreshing…":"Refresh"}</button></div>{myCampaigns.filter(c=>c.status==="pending_payment").length>0&&<button type="button" className="dangerBtn" onClick={clearUnpaid}>Remove unpaid campaigns ({myCampaigns.filter(c=>c.status==="pending_payment").length})</button>}{!myCampaigns.length?<p className="tiny">No campaigns yet. Completed campaigns will show spend, delivery and pacing here.</p>:myCampaigns.map(c=>{const target=Number(c.targetImpressions||0),delivered=Number(c.qualifiedImpressions||c.impressions||0),spend=Number(c.spend||0),remaining=Math.max(0,target-delivered);const days=Math.max(1,Number(c.durationDays||1));const daily=target?Math.ceil(target/days):0;return <div className="campaignRow" key={c.id}><div><b>{c.title||"Untitled campaign"}</b><span className={remaining===0?"campaignComplete":"campaignStatus"}>{remaining===0?"✓ Completed":(c.status||"In review")} · {c.startDate} → {c.endDate}</span></div><div><b>{delivered.toLocaleString()} / {target.toLocaleString()}</b><span>{moneyUsdNgn(spend)} spent · {moneyUsdNgn(Math.max(0,Number(c.totalBudgetUsd||0)-spend))} remaining · {Number(c.clicks||0).toLocaleString()} destination clicks</span></div>{c.status==="pending_payment"&&<div><button type="button" className="primary" onClick={()=>{setCampaignId(c.id);setAmountDue(Number(c.totalBudgetNgn)||0);setStep("pay")}}>Pay now</button></div>}{!["cancelled","completed"].includes(c.status)&&remaining>0&&<div><button type="button" className="dangerBtn" onClick={()=>cancelCampaign(c.id)}>Cancel campaign</button></div>}<div><b>{remaining.toLocaleString()}</b><span>impressions remaining · ~{daily.toLocaleString()}/day planned</span></div></div>})}</div></section>;
 if(step==="pay"&&campaignId)return <>{confirmEl}<CardPayment campaignId={campaignId} amountNgn={amountDue} onBack={()=>setStep("review")} onCancel={()=>cancelCampaign(campaignId)} onPaid={()=>{setStatus("Payment verified. Your sponsored Short is now ready for delivery.");refreshCampaigns();setCampaignId("");setAmountDue(0);setStep("prep")}}/></>;
 if(step==="review")return <section className="panel"><button onClick={()=>setStep("form")}>← Edit campaign</button><h1>Campaign & expense monitor</h1><div className="campaignMonitor"><div><small>TOTAL BUDGET</small><b>{moneyUsdNgn(estimatedBill)}</b></div><div><small>SPENT NOW</small><b>{moneyUsdNgn(0)}</b></div><div><small>REMAINING</small><b>{moneyUsdNgn(estimatedBill)}</b></div><div><small>DAILY PLAN</small><b>{moneyUsdNgn(dailyBudget)}</b></div><div><small>IMPRESSIONS/DAY</small><b>{dailyImpressions.toLocaleString()}</b></div><div><small>CAMPAIGN DAYS</small><b>{days}</b></div></div><div className="priceBox"><b>{form.promotionType==="app"?"App/site promotion":"Short promotion"}</b><span>Delivery: {startDate} → {endDate} ({days} day{days===1?"":"s"})</span><span>Target: {targetImpressions.toLocaleString()} qualified impressions</span><span>Billable: {billableImpressions.toLocaleString()} impressions</span><span>Rate: {moneyUsdNgn(VIDEO_PRICE_PER_BLOCK)} per 3,000-impression block</span><span>Planned spend/day: {moneyUsdNgn(dailyBudget)}</span><small>Spend is derived from qualified delivery, capped at the campaign target. The monitor separates delivered spend from the remaining budget.</small></div><button className="primary" disabled={submitting} onClick={async()=>{if(submitting)return;if(campaignId&&amountDue){setStep("pay");return;}setSubmitting(true);setStatus("");try{const u=auth.currentUser;if(!u||u.isAnonymous)throw new Error("Connect Google before creating an advertising campaign.");const r=await authedFetch(apiUrl("/api/ad-campaign"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...form,durationDays:days})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Campaign could not be created.");setCampaignId(d.campaignId||"");clearDraft();refreshCampaigns();if(d.paymentRequired){setAmountDue(Number(d.amountNgn)||0);setStep("pay");return;}setStatus("Campaign created and ready for delivery.");}catch(e){setStatus(e?.message||"Campaign could not be created.")}finally{setSubmitting(false)}}}>{submitting?"Preparing…":campaignId?"Continue to card payment":"Continue to secure payment"}</button>{campaignId&&<button type="button" className="dangerBtn" onClick={()=>cancelCampaign(campaignId)}>Cancel campaign</button>}{status&&<div className="status">{status}</div>}</section>;
 return <section className="panel"><button onClick={()=>setStep("prep")}>← Back</button><h1>Video campaign</h1>{draftRestored&&<div className="status draftNotice">Continuing from your saved draft. <button type="button" className="searchCancel" onClick={resetDraft}>Start over</button></div>}<form onSubmit={submit}><label>Promotion type<select value={form.promotionType} onChange={e=>update("promotionType",e.target.value)}><option value="short">Promote my Short</option><option value="app">Promote an app or site</option></select></label>{[["assetId","YouTube Shorts/video URL (already published)"],["brand","Brand / creator name"],["title","Campaign title"],["description","Description"],["targetImpressions","Target qualified impressions"],["duration","Campaign duration (days)"],["startDate","Start date"]].map(([k,l])=><label key={k}>{l}<input value={form[k]} onChange={e=>update(k,e.target.value)} type={k==="duration"||k==="targetImpressions"?"number":k==="startDate"?"date":"text"} min={k==="duration"?1:k==="targetImpressions"?3000:undefined} max={k==="duration"?90:k==="targetImpressions"?100000000:undefined} required={k!=="country"&&k!=="description"}/></label>)}<fieldset className="adCategoryPicker"><legend>Target viewer categories</legend><p className="tiny">Your sponsored Short is prioritized for viewers watching these categories. If delivery is slow, it may also appear in other categories to help complete your impression target.</p><div className="adCategoryGrid">{[["all","All categories"],["comedy","Comedy"],["tech","Tech"],["adventure","Adventure"],["science","Science"],["finance","Finance"],["education","Education"],["gaming","Gaming"],["sports","Sports"],["food","Food"],["music","Music"],["beauty","Beauty"],["new","Latest"]].map(([value,label])=><label key={value}><input type="checkbox" checked={(form.categories||["all"]).includes(value)} onChange={e=>{const old=form.categories||["all"];const next=e.target.checked?(value==="all"?["all"]:[...old.filter(x=>x!=="all"),value]):old.filter(x=>x!==value);update("categories",next.length?next:["all"]);}}/>{label}</label>)}</div></fieldset>{destinationRequired&&<div className="destinationFields"><label>App/site name shown on banner<input value={form.destinationName} onChange={e=>update("destinationName",e.target.value)} placeholder="e.g. Kivora" required/></label><label>Destination URL<input value={form.site} onChange={e=>update("site",e.target.value)} placeholder="https://example.com" inputMode="url" required/></label><label>App icon <span className="tiny">optional — pick an image, or the site favicon is used</span><span className="iconPicker"><span className="destinationIcon iconPickerPreview">{form.siteIcon?<img src={form.siteIcon} alt="App icon preview"/>:"◆"}</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={pickIcon}/>{form.siteIcon&&<button type="button" className="searchCancel" onClick={()=>update("siteIcon","")}>Remove</button>}</span></label><div className="destinationPreview"><span>LINK PREVIEW</span><div><span className="destinationIcon">{form.siteIcon?<img src={form.siteIcon} alt=""/>:"◆"}</span><strong>{form.destinationName||"Your app/site"}</strong><small>{form.site||"https://example.com"}</small><b>Open ↗</b></div></div></div>}<div className="priceBox"><span>Rate <b>{owner?"$0.00 (₦0) — owner billing bypass":moneyUsdNgn(VIDEO_PRICE_PER_BLOCK)+" / up to 3,000 qualified impressions"}</b></span><span>Billable target <b>{billableImpressions.toLocaleString()}</b></span><span>Estimated bill <b>{moneyUsdNgn(estimatedBill)}</b></span><span>Daily pacing <b>{dailyImpressions.toLocaleString()} impressions/day · {moneyUsdNgn(dailyBudget)}/day</b></span><span>Delivery window <b>{startDate} → {endDate}</b></span><small>{destinationRequired?"The app/site banner will appear directly beneath the sponsored video and link to the supplied destination.":"No destination link is required for Short-only promotion."}</small></div><button className="primary" disabled={submitting}>{submitting?"Checking…":"Review campaign & expenses"}</button></form>{status&&<div className="status">{status}</div>}</section>
}

function SponsoredCard({campaign,onNotice}){
 const source=campaign.assetSource||"youtube";
 const id=source==="drive"?campaign.assetId:extractYouTubeId(campaign.assetId||campaign.youtubeUrl||"");
 if(!id)return null;
 const video={id,source,assetId:campaign.assetId,title:campaign.title||"Sponsored Short",channelTitle:campaign.brand||"Advertiser",durationSeconds:Number(campaign.durationSeconds||30),site:campaign.site||"",destinationName:campaign.destinationName||campaign.brand||"",siteIcon:campaign.siteIcon||"",promotionType:campaign.promotionType||"short"};
 return <ShortsPlayer video={video} ad onNotice={onNotice} playbackKey={campaign.id} campaignId={campaign.id} audioConsent={false}/>;
}

function extractYouTubeId(value=""){
 try{const u=new URL(value.startsWith("http")?value:`https://${value}`); if(u.hostname.includes("youtu.be")) return u.pathname.slice(1).split("/")[0]; if(u.hostname.includes("youtube.com")) return u.searchParams.get("v")||u.pathname.split("/").filter(Boolean).pop()||"";}catch{} return "";
}

function FAQs(){
 const items=[
  ["Where do Kivora videos come from?","Organic videos are discovered through YouTube's API and played through YouTube's official embedded player. Kivora does not download or re-host the audiovisual stream. Sponsored campaigns are tracked separately from organic viewing."],
    ["Are sponsored videos clearly marked?","Yes. Paid campaigns that pass Kivora's approval flow are shown in the FYP with a Sponsored label."],
  ["How much does advertising cost?",`Kivora video advertising costs ${moneyUsdNgn(1.00)} per campaign, pricing $1 (₦1,300) per 3,000 target impressions (minimum target 3,000). A qualified impression requires at least 2 seconds of viewability at 50%+ visibility. Naira figures are display estimates using ₦${USD_TO_NGN_DISPLAY_RATE.toLocaleString()} per $1; the server remains authoritative for the final payment currency and amount.`],
  ["Does Kivora replace YouTube?","No. YouTube remains the source for YouTube content, playback, creator attribution and YouTube-specific actions."],
  ["Can I use Kivora in dark mode?","Yes. Choose Light, Dark or System mode from the menu. Your preference is saved on this device."],
  ["What native-style features does Kivora provide?","Kivora supports installable PWA behavior where the browser allows it, fullscreen playback, category discovery, account sign-in, and a lightweight vertical feed."]
 ];
 return <section className="panel faqPanel"><small>KIVORA HELP</small><h1>Frequently asked questions</h1><p>Quick answers about videos, ads, accounts and the Kivora experience.</p>{items.map(([q,a])=><details key={q}><summary>{q}</summary><p>{a}</p></details>)}</section>
}

function Legal({page}){
 const content={
 about:["About Kivora","Kivora is an independent entertainment discovery product. It organizes links and official embedded video sources so viewers can discover short-form entertainment in a Kivora-designed environment. Kivora is not YouTube and does not claim ownership of third-party videos.","Our catalog can use publicly available YouTube metadata and official embed playback. Availability can change when the original source changes, removes, restricts, or disables a video."],
 privacy:["Privacy","Kivora may process account identifiers, saved-video data and basic product analytics needed to operate the service. Google sign-in is required before the feed opens. Payment credentials are handled by the payment provider; Kivora should not store card details.","You can request deletion of Kivora account data through the contact route published by the operator. Third-party services such as Google, YouTube and Firebase may process data under their own terms and privacy policies. Do not submit sensitive personal information through Kivora."],
 terms:["Terms","Use Kivora lawfully and do not attempt to scrape, overload, bypass access controls, manipulate engagement, impersonate creators, or submit material you do not have rights to use. Kivora may remove campaigns or links that violate these rules or applicable law.","Video playback is supplied by the original platform. Kivora does not guarantee availability, accuracy, monetization status or continued access to third-party videos."],
 disclaimer:["Disclaimer","Kivora is an independent discovery service. References, thumbnails, titles and embedded videos can belong to their respective creators, publishers or platforms. Appearance in Kivora is not an endorsement, ownership claim or transfer of copyright.","Kivora does not download or re-host the audiovisual files used in its official embedded player flow. Where a rights holder believes a listing or link is inaccurate or should not appear, use the published contact route so it can be reviewed."],
 creators:["For creators & rights holders","Kivora is designed to make source attribution clear. We store video IDs/metadata and use the official YouTube embed/player rather than downloading or proxying the video. This means the audiovisual stream is supplied by YouTube, subject to the original video's availability and creator/platform settings.","We do not present Kivora likes or saves as YouTube engagement. Those are Kivora-only interactions. Sponsored content is also separated from organic discovery. If you own or represent content and believe a Kivora listing, metadata use, thumbnail, or placement needs correction or removal, contact the operator with the relevant video URL and your rights-holder details."],
 help:["Help & contact","For account, advertising, copyright or source-attribution questions, use the contact address published by the operator before launch. Include the relevant Kivora page URL and enough context to identify the issue.","For video availability or creator attribution, the original YouTube source is the authoritative source. For Kivora-specific data or interactions, Kivora is the appropriate contact."],
 }[page];
 return <section className="panel legal"><small>KIVORA INFORMATION</small><h1>{content[0]}</h1><p>{content[1]}</p><p>{content[2]}</p><div className="noticeBox"><b>Source principle</b><p>Kivora's role is discovery and presentation—not ownership of third-party audiovisual works.</p></div></section>
}
function authMessage(e){const c=e?.code; if(c==="auth/credential-already-in-use"||c==="auth/account-exists-with-different-credential") return "This Google account already has a Kivora account. Signing you into that existing account instead."; if(c==="auth/popup-blocked") return "Google sign-in was blocked by the browser. Kivora will use the secure redirect sign-in instead."; return e?.message||"Sign-in could not be completed."}

class StartupErrorBoundary extends React.Component {
 constructor(props){ super(props); this.state={failed:false,errorMessage:"",componentStack:""}; }
 static getDerivedStateFromError(error){ return {failed:true,errorMessage:String(error?.message||error||"Unknown rendering error")}; }
 componentDidCatch(error,info){ console.error("Kivora UI startup/render error:",error,info); this.setState({errorMessage:String(error?.stack||error?.message||error||"Unknown rendering error"),componentStack:String(info?.componentStack||"")}); }
 recover=async()=>{
   try {
     if ("serviceWorker" in navigator) {
       const regs=await navigator.serviceWorker.getRegistrations();
       await Promise.all(regs.map(reg=>reg.unregister()));
     }
     if ("caches" in window) {
       const keys=await caches.keys();
       await Promise.all(keys.filter(k=>k.startsWith("kivora-pwa-")).map(k=>caches.delete(k)));
     }
   } catch(e){ console.warn("Kivora recovery cleanup failed",e); }
   window.location.reload();
 };
 render(){
   if(this.state.failed) return <main style={{minHeight:"100dvh",display:"grid",placeItems:"center",padding:24,background:"#f7f7f2",color:"#171717",fontFamily:"system-ui,sans-serif"}}>
     <section style={{maxWidth:420,width:"100%",padding:24,borderRadius:18,background:"#fff",boxShadow:"0 8px 32px #0001"}}>
       <h1 style={{marginTop:0}}>Kivora couldn't start</h1>
       <p>The app encountered a rendering error. Your Google account has not been deleted. Use the error details below to diagnose the problem.</p>
       <pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",fontSize:12,background:"#f3f3f3",color:"#222",padding:12,borderRadius:8,maxHeight:180,overflow:"auto"}}>{this.state.errorMessage || "No error message captured."}{this.state.componentStack}</pre>
       <button onClick={()=>window.location.reload()} style={{padding:"12px 16px",border:0,borderRadius:10,marginRight:8}}>Reload app</button>
       <button onClick={this.recover} style={{padding:"12px 16px",border:0,borderRadius:10}}>Reset offline cache</button>
     </section>
   </main>;
   return this.props.children;
 }
}
const rootElement=document.getElementById("root");
if(rootElement) createRoot(rootElement).render(<StartupErrorBoundary><App/></StartupErrorBoundary>);

// Warm the YouTube player script as soon as the app loads so the first Short starts faster.
if(typeof window!=="undefined"){try{loadYouTubeApi(()=>{})}catch{}}
