import React,{useEffect,useRef,useState} from "react";
import {createRoot} from "react-dom/client";
import "./styles.css";
import { isLikelySpam, effectiveOriginality, canRecommend, isEligibleShort } from "./videoDiscovery";
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
 const [tab,setTab]=useState("home"),[premium,setPremium]=useState(false),[menu,setMenu]=useState(false);
 const [user,setUser]=useState(auth.currentUser),[busy,setBusy]=useState(false),[notice,setNotice]=useState("");
 const [notifyPrompt,setNotifyPrompt]=useState(true);
 const [pendingNewVideos,setPendingNewVideos]=useState(0),[ratings,setRatings]=useState({}),[query,setQuery]=useState(""),[category,setCategory]=useState("all"),[videos,setVideos]=useState(EMPTY_VIDEOS),[pageTokens,setPageTokens]=useState([]),[hasMore,setHasMore]=useState(true),[loadingMore,setLoadingMore]=useState(false),[sponsored,setSponsored]=useState([]),[videoLoading,setVideoLoading]=useState(true),[videoError,setVideoError]=useState(""),[theme,setTheme]=useState(()=>localStorage.getItem("kivora-theme")||"system"),[installPrompt,setInstallPrompt]=useState(null),[selectedVideo,setSelectedVideo]=useState(null);
 const feedSentinelRef=useRef(null),feedRef=useRef(null);
 const signedIn=!!user&&!user.isAnonymous;
 const owner=isKivoraOwner(user);


 useEffect(()=>{
   const params=new URLSearchParams(window.location.search);
   const payment=params.get("payment");
   const campaignId=params.get("campaignId");
   const transactionId=params.get("transaction_id");
   if(payment!=="campaign"||!campaignId||!transactionId)return;
   let cancelled=false;
   (async()=>{
     try{
       const u=auth.currentUser;
       if(!u||u.isAnonymous)return;
       const token=await u.getIdToken();
       const r=await fetch("/api/ad-campaign?action=verify",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({campaignId,transactionId})});
       const d=await r.json();
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
   const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))loadMoreVideos()},{root:feedRef.current,rootMargin:"100% 0px"});
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

 return <div className={`app ${tab==="home"?"homeFyp":""}`}>
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
   {tab==="home"&&<>
    <nav className="categoryNav" aria-label="Shorts categories">{[
      ["all","All"],["comedy","Comedy"],["tech","Tech"],["adventure","Adventure"],
      ["science","Science"],["finance","Finance"],["education","Education"],["gaming","Gaming"],["sports","Sports"],
      ["food","Food"],["music","Music"],["beauty","Beauty"],["new","New"]
    ].map(([key,label])=><button key={key} className={category===key?"active":""} onClick={()=>{setCategory(key);setQuery("")}}>{label}</button>)}</nav>
    <section className="discoverTools"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search Shorts…" aria-label="Search Kivora Shorts"/><span>{query?"Search results":"Choose a category to personalize this Shorts feed."}</span></section>
    {videoLoading&&<section className="sourceNote"><b>Finding videos…</b><p>Kivora is loading live YouTube discovery results.</p></section>}
    {videoError&&<section className="sourceNote"><b>Video discovery notice</b><p>{videoError}</p>{query.trim()&&<button onClick={()=>setQuery("")}>Back to Discover</button>}</section>}
    <div className="feed" ref={feedRef}>{(()=>{
      const ranked=videos.filter(v=>{
        const r=ratings[v.id]||{};
        const item={...v,...r};
        return isEligibleShort(item)&&!isLikelySpam(item)&&(query.trim()?true:canRecommend(item));
      }).map(v=>{
        const r=ratings[v.id]||{};
        const viewerRating=effectiveOriginality(r.ratingAverage,r.ratingCount);
        const engagement=Number(v.engagementScore||0);
        const recScore=(viewerRating/5)*25 + Math.min(75,engagement*3.5);
        return {...v,recScore};
      });
      ranked.sort((a,b)=>category==="new"?new Date(b.publishedAt||0)-new Date(a.publishedAt||0):b.recScore-a.recScore);
      const cards=[];
      ranked.forEach((v,i)=>{
        cards.push(<ShortsPlayer key={v.id} video={v} onOpen={openVideo} onNotice={setNotice}/>);
        if(sponsored.length && (i===3 || (i>3 && (i-3)%6===0))){const ad=sponsored[Math.min(Math.floor(i/6),sponsored.length-1)];const adVideo={id:ad.assetSource==="drive"?ad.assetId:extractYouTubeId(ad.assetId||ad.youtubeUrl||""),source:ad.assetSource||"youtube",assetId:ad.assetId,title:ad.title||"Sponsored Short",channelTitle:ad.brand||"Advertiser",durationSeconds:Number(ad.durationSeconds||ad.duration||30),site:ad.site||"",destinationName:ad.destinationName||ad.brand||"",siteIcon:ad.siteIcon||"",promotionType:ad.promotionType||"short"};if(adVideo.id)cards.push(<ShortsPlayer key={`ad-${ad.id}-${i}`} video={adVideo} onNotice={setNotice} ad playbackKey={ad.id} campaignId={ad.id}/>);}
      });
      if(!cards.length&&!videoLoading)cards.push(<section className="emptyState" key="empty"><h3>No videos to show</h3><p>Try another category or search term.</p></section>);
      return cards;
    })()}<div ref={feedSentinelRef} className="feedSentinel" aria-live="polite">{loadingMore&&<><span className="feedSpinner"/>Finding more Shorts…</>}{!loadingMore&&!hasMore&&videos.length>0&&<span>You've reached the end of the available Shorts.</span>}</div></div>
    <details className="sourceNote sourceDetails"><summary><b>How Kivora's feed works</b></summary><p>The Kivora FYP is a dedicated vertical Shorts viewer: one eligible Short per viewport, automatic playback on entry, and snap scrolling. New sorts by publication date. The feed is Shorts-first: only eligible videos up to 180 seconds are shown. Long-form videos are excluded server-side. Sponsored placements are video-only and clearly labelled. Sponsored placements are clearly labelled and inserted into the same FYP flow as other content.</p></details>
    <details className="sourceNote sourceDetails"><summary><b>Subtitles & language</b></summary><p>Kivora can use the official YouTube player's caption system when a source video provides captions. You can turn captions on/off and choose a preferred caption language. YouTube decides which original or translated caption tracks are available; Kivora does not download or re-host caption files.</p></details>
    <details className="sourceNote sourceDetails"><summary><b>How Kivora gets videos</b></summary><p>Kivora uses official YouTube video IDs and metadata, then plays the creator's video through YouTube's official embedded player. The original source, creator and YouTube controls remain attributable to the source platform.</p><button onClick={()=>go("creators")}>Read our creator & rights policy →</button></details>
   </>}
   {tab==="watchlist"&&<Saved user={user} videos={videos} onNotice={setNotice}/>}
   {tab==="history"&&<section className="panel"><h1>Recently watched</h1><p>Your local viewing history will appear here. Kivora keeps this separate from YouTube's own view history.</p></section>}
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


function extractDriveId(value=""){
 const s=String(value||"").trim();
 if(/^[A-Za-z0-9_-]{20,}$/.test(s)) return s;
 const m=s.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?id=)([A-Za-z0-9_-]+)/i);
 return m?.[1]||"";
}

async function youtubeAction(action,videoId,body={}){
 const u=auth.currentUser;
 if(!u||u.isAnonymous) throw new Error("Connect Google to use YouTube actions.");
 const accessToken=await getYouTubeAccessToken();
 const idToken=await u.getIdToken();
 const res=await fetch("/api/youtube-actions",{
  method:"POST",
  headers:{"Content-Type":"application/json",Authorization:`Bearer ${idToken}`},
  body:JSON.stringify({action,videoId,accessToken,...body})
 });
 let data={};try{data=await res.json()}catch{}
 if(!res.ok) throw new Error(data?.error||"YouTube action failed.");
 return data;
}

async function fetchYouTubeComments(videoId,pageToken=""){
 const params=new URLSearchParams({videoId:String(videoId||"")});
 if(pageToken)params.set("pageToken",pageToken);
 const res=await fetch(`/api/youtube-actions?${params}`,{headers:{accept:"application/json"}});
 let data={};try{data=await res.json()}catch{}
 if(!res.ok) throw new Error(data?.error||"Comments could not be loaded.");
 return data;
}

function ShortsPlayer({video,onOpen,onNotice,ad=false,playbackKey="",campaignId=""}){
 const box=useRef(null),player=useRef(null),visibleRef=useRef(false),countedRef=useRef(false),impressionTimer=useRef(null),playerStartedRef=useRef(false),exposureKey=useRef(crypto.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`),lastTapRef=useRef({time:0,x:0,y:0});
 const [ready,setReady]=useState(false),[playing,setPlaying]=useState(false),[liked,setLiked]=useState(false),[saved,setSaved]=useState(false),[actionBusy,setActionBusy]=useState(false),[commentsOpen,setCommentsOpen]=useState(false),[comments,setComments]=useState([]),[commentText,setCommentText]=useState(""),[commentsLoading,setCommentsLoading]=useState(false),[commentPosting,setCommentPosting]=useState(false),[visibleRatio,setVisibleRatio]=useState(0),[liveStats,setLiveStats]=useState({likes:Number(video.youtubeLikeCount||0),comments:Number(video.commentCount||0)});
 const driveId=video.source==="drive"?video.id:extractDriveId(video.assetId||"");
 const isDrive=Boolean(driveId);
 const id=`yt-short-${String(video.id).replace(/[^A-Za-z0-9_-]/g,"")}-${playbackKey|| (ad?"sponsored":"organic")}`;

 async function reportQualifiedImpression(){
   if(!ad||!campaignId||countedRef.current)return;
   const u=auth.currentUser; countedRef.current=true;
   try{
     const headers={"Content-Type":"application/json"};
     if(u&&!u.isAnonymous) headers.Authorization=`Bearer ${await u.getIdToken()}`;
     const res=await fetch("/api/ad-impression",{method:"POST",headers,body:JSON.stringify({campaignId,impressionKey:`${campaignId}-${exposureKey.current}`,viewerKey:`${u?.uid||"anonymous"}-${exposureKey.current}`,secondsViewed:2,visibleRatio:Math.max(.5,visibleRatio),source:isDrive?"drive":"youtube"})});
     if(!res.ok)countedRef.current=false;
   }catch{countedRef.current=false;}
 }
 function armImpression(){if(!ad||!campaignId||countedRef.current||impressionTimer.current)return;impressionTimer.current=setTimeout(()=>{impressionTimer.current=null;if(visibleRef.current&&(isDrive||playing))reportQualifiedImpression()},2000)}
 function disarmImpression(){if(impressionTimer.current){clearTimeout(impressionTimer.current);impressionTimer.current=null}}

 useEffect(()=>{
   let cancelled=false;
   if(isDrive){setReady(true);return()=>{cancelled=true;disarmImpression()}};
   const start=()=>{
     if(cancelled||playerStartedRef.current||!window.YT?.Player||!box.current||document.getElementById(id)?.dataset.loaded==="1")return;
     const el=document.getElementById(id);if(!el)return;
     playerStartedRef.current=true;el.dataset.loaded="1";
     player.current=new window.YT.Player(id,{videoId:video.id,width:"100%",height:"100%",playerVars:{autoplay:1,controls:0,rel:0,playsinline:1,enablejsapi:1,iv_load_policy:3,disablekb:1,fs:0,origin:window.location.origin},events:{
       onReady:()=>{if(cancelled)return;setReady(true);try{player.current.unMute();player.current.playVideo();if(visibleRef.current)setPlaying(true)}catch{}},
       onStateChange:e=>{if(window.YT?.PlayerState&&e.data===window.YT.PlayerState.PLAYING){setPlaying(true);armImpression()}if(window.YT?.PlayerState&&[window.YT.PlayerState.PAUSED,window.YT.PlayerState.ENDED].includes(e.data)){setPlaying(false);disarmImpression()}},
       onAutoplayBlocked:()=>{try{player.current.mute();player.current.playVideo();setPlaying(true)}catch{}}
     }});
   };
   const node=box.current;if(!node)return()=>{cancelled=true};
   const observer=new IntersectionObserver(entries=>{if(entries[0]?.isIntersecting)loadYouTubeApi(start)},{root:null,rootMargin:"100% 0px",threshold:0});
   observer.observe(node);
   return()=>{cancelled=true;observer.disconnect();disarmImpression();try{player.current?.destroy()}catch{}player.current=null;playerStartedRef.current=false};
 },[video.id,id,isDrive,campaignId]);

 useEffect(()=>{
   const node=box.current;if(!node)return;
   const observer=new IntersectionObserver(entries=>{
     const entry=entries[0];if(!entry)return;
     const ratio=Number(entry.intersectionRatio||0);setVisibleRatio(ratio);
     const active=entry.isIntersecting&&ratio>=.72;visibleRef.current=active;
     if(!player.current||!ready){if(active&&isDrive)armImpression();else if(!active)disarmImpression();return;}
     try{if(active){player.current.unMute();player.current.playVideo();setPlaying(true);armImpression()}else{player.current.pauseVideo();setPlaying(false);disarmImpression()}}catch{}
   },{threshold:[0,.5,.72,.9]});
   observer.observe(node);return()=>{observer.disconnect();disarmImpression()};
 },[ready,isDrive]);

 async function refreshYouTubeStats(){
   try{
     const res=await fetch(`/api/youtube-search?videoId=${encodeURIComponent(video.id)}`,{headers:{accept:"application/json"}});
     const data=await res.json();const item=data?.items?.[0];
     if(item?.statistics)setLiveStats({likes:Number(item.statistics.likeCount||0),comments:Number(item.statistics.commentCount||0)});
   }catch{}
 }
 async function ensureYouTubeAccess(){
   if(!auth.currentUser||auth.currentUser.isAnonymous)throw new Error("Connect Google to use YouTube actions.");
 }
 async function toggleYouTubeLike(){
   if(isDrive||ad)return;
   if(actionBusy)return;
   setActionBusy(true);
   try{
     await ensureYouTubeAccess();
     const result=await youtubeAction("like",video.id);
     setLiked(result.rating==="like");
     if(result.statistics)setLiveStats({likes:Number(result.statistics.likeCount||0),comments:Number(result.statistics.commentCount||0)});else await refreshYouTubeStats();
   }catch(e){onNotice?.(e?.message||"Could not update the YouTube like.")}
   finally{setActionBusy(false)}
 }
 async function toggleYouTubeSave(){
   if(isDrive||ad)return;
   if(actionBusy)return;
   setActionBusy(true);
   try{
     await ensureYouTubeAccess();
     const result=await youtubeAction("save",video.id);
     setSaved(Boolean(result.saved));
     onNotice?.(result.saved?"Saved to your YouTube playlist":"Removed from your YouTube playlist");
   }catch(e){onNotice?.(e?.message||"Could not update YouTube Save.")}
   finally{setActionBusy(false)}
 }
 async function openComments(){
   if(isDrive)return;
   setCommentsOpen(true);setCommentsLoading(true);
   try{const data=await fetchYouTubeComments(video.id);setComments(data.items||[])}catch(e){onNotice?.(e?.message||"Comments could not be loaded.")}
   finally{setCommentsLoading(false)}
 }
 async function postComment(e){
   e?.preventDefault();const text=commentText.trim();if(!text||commentPosting)return;
   setCommentPosting(true);
   try{
     const data=await youtubeAction("comment",video.id,{text});
     if(data.comment)setComments(prev=>[data.comment,...prev]);
     setCommentText("");
     if(data.statistics)setLiveStats({likes:Number(data.statistics.likeCount||0),comments:Number(data.statistics.commentCount||0)});else await refreshYouTubeStats();
     onNotice?.("Comment posted to YouTube.");
   }catch(e){onNotice?.(e?.message||"Could not post the comment to YouTube.")}
   finally{setCommentPosting(false)}
 }
 function enableSound(){try{player.current?.unMute?.();player.current?.playVideo?.();setPlaying(true)}catch{}}
 function handleGesture(e){
   if(ad)return;
   const now=Date.now(),x=e.clientX||0,y=e.clientY||0,last=lastTapRef.current;
   const isDouble=now-last.time<320&&Math.hypot(x-last.x,y-last.y)<28;
   lastTapRef.current={time:now,x,y};
   if(isDouble){e.preventDefault?.();toggleYouTubeLike();return;}
   enableSound();
 }
 const embed=isDrive?`https://drive.google.com/file/d/${encodeURIComponent(driveId)}/preview?autoplay=1`:"";
 return <article className={`shortCard ${ad?"shortAdCard":""}`} ref={box}>
   <div className="shortPlayer">
     {isDrive?<iframe className="shortYT shortDriveFrame" src={embed} title={video.title||"Sponsored video"} allow="autoplay; fullscreen" allowFullScreen onLoad={()=>{setReady(true);if(visibleRef.current)armImpression()}}/>:<div id={id} className="shortYT"/>}
     {!ad&&<div className="shortGestureLayer" aria-label="Video gesture surface" onPointerUp={handleGesture}/>} 
     {ad&&<div className="shortTopline"><span>SPONSORED</span></div>}
     <div className="shortGradient" aria-hidden="true"/>
     {!ad&&!isDrive&&<div className="shortRail" aria-label="YouTube actions">
       <button className={`shortMetric ${liked?"active":""}`} onClick={toggleYouTubeLike} disabled={actionBusy} aria-label={liked?"Unlike":"Like"}><span className="shortMetricIcon">♥</span><b>{Number(liveStats.likes||0).toLocaleString()}</b></button>
       <button className="shortMetric" onClick={openComments} disabled={commentsLoading} aria-label="Comments"><span className="shortMetricIcon">💬</span><b>{Number(liveStats.comments||0).toLocaleString()}</b></button>
       <button className={`shortMetric ${saved?"active":""}`} onClick={toggleYouTubeSave} disabled={actionBusy} aria-label={saved?"Remove saved":"Save to YouTube"}><span className="shortMetricIcon">🔖</span><b>{saved?"Saved":"Save"}</b></button>
     </div>}
     <div className="shortBottomInfo" onClick={e=>e.stopPropagation()}><div className="shortCreator"><span className="shortAvatar">{(video.channelTitle||"Y").slice(0,1).toUpperCase()}</span><b>{video.channelTitle||"YouTube"}</b></div><h2>{video.title}</h2><p>{Number(video.viewCount||0).toLocaleString()} views · {Number(liveStats.likes||0).toLocaleString()} likes · {Number(liveStats.comments||0).toLocaleString()} comments{video.desc?` · ${video.desc.slice(0,70)}${video.desc.length>70?"…":""}`:""}</p>{ad&&<div className="shortAdMeta"><span>Sponsored video · Kivora ad</span>{isDrive?<small>Hosted by Google Drive · Kivora does not store the file</small>:<small>YouTube playback · YouTube may independently serve ads inside its player</small>}</div>}</div>
   </div>
   {ad&&video.promotionType==="app"&&video.site&&<a className="shortDestinationBanner" href={video.site} target="_blank" rel="noopener noreferrer"><span className="destinationIcon"><img src={video.siteIcon||`https://www.google.com/s2/favicons?domain=${encodeURIComponent(video.site)}&sz=128`} alt="" onError={e=>{e.currentTarget.style.display="none"}}/></span><span className="destinationCopy"><b>{video.destinationName||video.channelTitle||"Visit advertiser"}</b><small>{video.site.replace(/^https?:\/\//i,"").replace(/\/$/,"")}</small></span><strong>Open ↗</strong></a>}
   {commentsOpen&&<div className="commentsSheet" role="dialog" aria-modal="true" onClick={()=>setCommentsOpen(false)}><div className="commentsPanel" onClick={e=>e.stopPropagation()}><div className="commentsHead"><b>Comments</b><button onClick={()=>setCommentsOpen(false)} aria-label="Close comments">×</button></div><div className="commentsList">{commentsLoading?<p className="tiny">Loading comments from YouTube…</p>:comments.length?comments.map(c=><div className="ytComment" key={c.id}><b>{c.author}</b><p>{c.text}</p></div>):<p className="tiny">No comments available for this video.</p>}</div><form className="commentComposer" onSubmit={postComment}><input value={commentText} onChange={e=>setCommentText(e.target.value)} placeholder="Comment on YouTube…" maxLength={10000}/><button className="primary" disabled={commentPosting||!commentText.trim()}>{commentPosting?"Posting…":"Post"}</button></form></div></div>}
 </article>
}

function SponsoredCard({campaign,onNotice}){
 const source=campaign.assetSource||"youtube";
 const id=source==="drive"?campaign.assetId:extractYouTubeId(campaign.assetId||campaign.youtubeUrl||"");
 if(!id)return null;
 const video={id,source,assetId:campaign.assetId,title:campaign.title||"Sponsored Short",channelTitle:campaign.brand||"Advertiser",durationSeconds:Number(campaign.durationSeconds||30),site:campaign.site||"",destinationName:campaign.destinationName||campaign.brand||"",siteIcon:campaign.siteIcon||"",promotionType:campaign.promotionType||"short"};
 return <ShortsPlayer video={video} ad onNotice={onNotice} playbackKey={campaign.id} campaignId={campaign.id}/>;
}

function extractYouTubeId(value=""){
 try{const u=new URL(value.startsWith("http")?value:`https://${value}`); if(u.hostname.includes("youtu.be")) return u.pathname.slice(1).split("/")[0]; if(u.hostname.includes("youtube.com")) return u.searchParams.get("v")||u.pathname.split("/").filter(Boolean).pop()||"";}catch{} return "";
}

function FAQs(){
 const items=[
  ["Where do Kivora videos come from?","Organic videos are discovered through YouTube's API and played through YouTube's official embedded player. Kivora does not download or re-host the audiovisual stream. Sponsored campaigns are tracked separately from organic viewing."],
    ["Are sponsored videos clearly marked?","Yes. Paid campaigns that pass Kivora's approval flow are shown in the FYP with a Sponsored label."],
  ["How much does advertising cost?",`Kivora uses video-only advertising at ${moneyUsdNgn(1.00)} per 1,500 qualified video impressions. A qualified impression requires at least 2 seconds of viewability at 50%+ visibility. Naira figures are display estimates using ₦${USD_TO_NGN_DISPLAY_RATE.toLocaleString()} per $1; the server remains authoritative for the final payment currency and amount.`],
  ["Does Kivora replace YouTube?","No. YouTube remains the source for YouTube content, playback, creator attribution and YouTube-specific actions."],
  ["Can I use Kivora in dark mode?","Yes. Choose Light, Dark or System mode from the menu. Your preference is saved on this device."],
  ["What native-style features does Kivora provide?","Kivora supports installable PWA behavior where the browser allows it, fullscreen playback, device sharing, saved videos, watch-first access and push notifications after permission is granted."]
 ];
 return <section className="panel faqPanel"><small>KIVORA HELP</small><h1>Frequently asked questions</h1><p>Quick answers about videos, ads, accounts and the Kivora experience.</p>{items.map(([q,a])=><details key={q}><summary>{q}</summary><p>{a}</p></details>)}</section>
}

function Legal({page}){
 const content={
 about:["About Kivora","Kivora is an independent entertainment discovery product. It organizes links and official embedded video sources so viewers can discover short-form entertainment in a Kivora-designed environment. Kivora is not YouTube and does not claim ownership of third-party videos.","Our catalog can use publicly available YouTube metadata and official embed playback. Availability can change when the original source changes, removes, restricts, or disables a video."],
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
