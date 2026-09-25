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
  engagementScore:Number(item?.engagementScore||0)
 };
}

async function fetchKivoraVideos(query="", category="all"){
 const params=new URLSearchParams();
 if(query) params.set("q",query);
 if(category && category!=="all") params.set("category",category);
 const qs=params.toString();
 const url=`/api/youtube-search${qs?`?${qs}`:""}`;
 const res=await fetch(url,{headers:{accept:"application/json"}});
 let data={};
 try{data=await res.json()}catch{}
 if(!res.ok) throw new Error(data?.error || `Video discovery failed (${res.status})`);
 const items=Array.isArray(data?.items)?data.items.map(normalizeVideo).filter(Boolean):[];
 return {items,source:data?.source||"youtube"};
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
 const [tab,setTab]=useState("home"),[premium,setPremium]=useState(false),[menu,setMenu]=useState(false);
 const [user,setUser]=useState(auth.currentUser),[busy,setBusy]=useState(false),[notice,setNotice]=useState("");
 const [notifyPrompt,setNotifyPrompt]=useState(true);
 const [pendingNewVideos,setPendingNewVideos]=useState(0),[ratings,setRatings]=useState({}),[query,setQuery]=useState(""),[category,setCategory]=useState("all"),[videos,setVideos]=useState(EMPTY_VIDEOS),[sponsored,setSponsored]=useState([]),[videoLoading,setVideoLoading]=useState(true),[videoError,setVideoError]=useState(""),[theme,setTheme]=useState(()=>localStorage.getItem("kivora-theme")||"system"),[installPrompt,setInstallPrompt]=useState(null);
 const signedIn=!!user&&!user.isAnonymous;
 const owner=isKivoraOwner(user);
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
   Promise.all(videos.map(v=>getDoc(doc(db,"videos",v.id)).catch(()=>null))).then(snaps=>{if(!live)return;const next={};snaps.forEach((s,i)=>{const d=s?.data()||{};next[videos[i].id]={ratingAverage:Number(d.ratingAverage||3),ratingCount:Number(d.ratingCount||0)}});setRatings(next)});
   return()=>{live=false};
 },[videos]);

 useEffect(()=>{
   const q=query.trim();
   const timer=setTimeout(async()=>{
    setVideoLoading(true);setVideoError("");
    try{
      const result=await fetchKivoraVideos(q,category);
      setVideos(result.items);
      if(!result.items.length)setVideoError(q?"No YouTube videos matched that search.":"YouTube returned no videos for Kivora right now.");
    }catch(e){setVideoError(e?.message||"Video discovery could not be completed.");setVideos([]);}
    finally{setVideoLoading(false);}
   },q?450:50);
   return()=>clearTimeout(timer);
 },[query,category]);

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
 const go=t=>{setTab(t);setMenu(false);window.scrollTo({top:0,behavior:"auto"})};

 return <div className="app">
  <header className="topbar">
   <button className="brand" onClick={()=>go("home")}>Kivora</button>
   <div className="topActions">
    <button className="menuBtn" aria-label="Open menu" onClick={()=>setMenu(!menu)}>☰ <span>Menu</span></button>
    {!signedIn&&<button className="signinMini" onClick={google} disabled={busy}>Sign in</button>}
    {signedIn&&<button className="avatar" onClick={()=>go("account")} aria-label="Account">K</button>}
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
        cards.push(<VideoCard key={v.id} video={v} user={user} onNotice={setNotice} isPro={premium} suggested={!query.trim() && category!=="new" && i<5}/>);
        if(sponsored.length && (i===2 || (i>2 && (i-2)%5===0))){const ad=sponsored[Math.min(Math.floor(i/5),sponsored.length-1)];cards.push(<SponsoredCard key={`ad-${ad.id}-${i}`} campaign={ad} onNotice={setNotice}/>);}
      });
      if(!cards.length&&!videoLoading)cards.push(<section className="emptyState" key="empty"><h3>No videos to show</h3><p>Try another category or search term.</p></section>);
      return cards;
    })()}</div>
    <details className="sourceNote sourceDetails"><summary><b>How Kivora's feed works</b></summary><p>Suggested videos combine public YouTube engagement signals with Kivora viewer ratings. New sorts by publication date. Categories focus on action movies across major film industries. Recaps, explainers, reviews, reactions, trailers, Shorts and similar non-movie results are filtered out. Sponsored placements are clearly labelled and inserted into the same FYP flow as other content.</p></details>
    <details className="sourceNote sourceDetails"><summary><b>Google-powered translated captions</b></summary><p>Kivora Pro can use translated caption tracks exposed by the embedded YouTube player when translation is available for the source video. Kivora does not download or re-host caption files.</p></details>
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

function VideoCard({video,user,onNotice,isPro=false,suggested=false}){
 const box=useRef(null),player=useRef(null),readyRef=useRef(false),visibleRef=useRef(false),[ready,setReady]=useState(false),[muted,setMuted]=useState(true);
 const [captions,setCaptions]=useState(false),[captionLang,setCaptionLang]=useState("en"),[liked,setLiked]=useState(false),[likes,setLikes]=useState(0),[saved,setSaved]=useState(false);
 const [playing,setPlaying]=useState(false),[seekOverlay,setSeekOverlay]=useState(null);
 const tapCountRef=useRef({left:0,right:0,timer:null});
 useEffect(()=>{
  let observer,cancelled=false;
  const applyVisibility=()=>{
   if(!player.current||!readyRef.current)return;
   if(visibleRef.current){try{player.current.mute();player.current.playVideo();setMuted(true)}catch{}}
   else{try{player.current.pauseVideo()}catch{}}
  };
  const load=()=>{
   if(cancelled||!window.YT?.Player||!box.current||document.getElementById(`yt-${video.id}`)?.dataset.ready)return;
   player.current=new window.YT.Player(`yt-${video.id}`,{videoId:video.id,width:"100%",height:"100%",
    playerVars:{autoplay:0,controls:1,rel:0,modestbranding:1,playsinline:1,enablejsapi:1,cc_load_policy:0,cc_lang_pref:"en"},
    events:{onReady:()=>{readyRef.current=true;setReady(true);const el=document.getElementById(`yt-${video.id}`);if(el)el.dataset.ready="1";applyVisibility();},onStateChange:e=>setPlaying(e.data===window.YT.PlayerState.PLAYING)}
   });
  };
  loadYouTubeApi(load);
  observer=new IntersectionObserver(entries=>{
    const e=entries[0];
    visibleRef.current=e.isIntersecting && e.intersectionRatio>=.55;
    applyVisibility();
  },{threshold:[0,.55,1]});
  if(box.current)observer.observe(box.current);
  return()=>{cancelled=true;readyRef.current=false;observer?.disconnect();try{player.current?.destroy()}catch{}};
 },[video.id]);
 useEffect(()=>{if(!user)return;const key=`kivora-like-${video.id}-${user.uid}`;setLiked(localStorage.getItem(key)==="1");},[user,video.id]);
 async function like(){if(!user){onNotice("Start watching first to interact.");return}try{const next=await toggleLike(video.id,user.uid);setLiked(next);localStorage.setItem(`kivora-like-${video.id}-${user.uid}`,next?"1":"0");setLikes(x=>Math.max(0,x+(next?1:-1)));}catch(e){onNotice(e.message)}}
 async function save(){if(!user){onNotice("Start watching first to save videos.");return}try{setSaved(await saveVideo(video.id,user.uid));}catch(e){onNotice(e.message)}}
 function mute(){if(!player.current)return;try{if(muted){player.current.unMute();setMuted(false)}else{player.current.mute();setMuted(true)}}catch{}}
 function cc(lang=captionLang){
  if(!isPro){onNotice("Caption translation are a Kivora Pro feature.");return}
  if(!player.current)return;
  try{
    player.current.loadModule("captions");
    player.current.setOption("captions","track",{language:lang});
    setCaptions(true); setCaptionLang(lang);
  }catch{onNotice("This video may not have captions or a translated track available.")}
}
 function handleSeekTap(side){
   if(!player.current || !readyRef.current) return;
   const state=tapCountRef.current;
   const count=Math.min(20,(state[side]||0)+1);
   state[side]=count;
   clearTimeout(state.timer);
   state.timer=setTimeout(()=>{
     if(count>=2){
       const seconds=(count-1)*10;
       try{
         const current=Number(player.current.getCurrentTime?.()||0);
         const duration=Number(player.current.getDuration?.()||0);
         const next=side==="right" ? Math.min(duration,current+seconds) : Math.max(0,current-seconds);
         player.current.seekTo(next,true);
       }catch{}
       setSeekOverlay({side,seconds});
       setTimeout(()=>setSeekOverlay(null),700);
     }
     state[side]=0;
   },360);
 }
 async function landscape(){
   try{
     if(!document.fullscreenElement) await box.current?.requestFullscreen?.();
     await screen.orientation?.lock?.("landscape");
   }catch{}
 }
 async function share(){const url=location.href+`#video-${video.id}`;try{if(navigator.share){await navigator.share({title:video.title,url});return}if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(url);onNotice("Kivora link copied.");return}throw new Error("copy unavailable")}catch(e){if(e?.name!=="AbortError")onNotice("Copy the page link to share.")}}
 return <article className="videoCard" id={`video-${video.id}`}>
  <div className="playerWrap" ref={box}>
   <div id={`yt-${video.id}`} className="ytPlayer"/>
   <button className="seekZone seekLeft" aria-label="Tap to rewind" onClick={()=>handleSeekTap("left")} />
   <button className="seekZone seekRight" aria-label="Tap to fast forward" onClick={()=>handleSeekTap("right")} />
   {seekOverlay&&<div className={`seekOverlay ${seekOverlay.side}`}>{seekOverlay.side==="right"?"▶":"◀"} x{seekOverlay.seconds}</div>}
   <div className="autoBadge">{playing?"Playing":"Kivora player"} · {muted?"Muted":"Sound on"}</div>
   <div className="playerTools"><button onClick={mute}>{muted?"🔇 Unmute":"🔊 Mute"}</button><button onClick={landscape}>⛶ Landscape</button><button onClick={()=>box.current?.requestFullscreen?.().catch(()=>{})}>⛶ Fullscreen</button><button className={!isPro?"proTool":""} onClick={()=>cc(captionLang)}>{isPro?(captions?"CC On":"CC + Translate"):"🔒 Pro captions"}</button></div>
  </div>
  <div className="videoBody"><div className="videoMetaLine"><div className="eyebrow">{video.lang}</div>{suggested&&<span className="suggestedBadge">SUGGESTED</span>}</div><h2>{video.title}</h2><details className="videoInfo"><summary>About this video</summary><p>{video.desc}</p><span>{video.channelTitle||"YouTube source"}{video.publishedAt?` · ${new Date(video.publishedAt).toLocaleDateString()}`:""}</span><span>{Number(video.viewCount||0).toLocaleString()} views · {Number(video.youtubeLikeCount||0).toLocaleString()} YouTube likes · {Number(video.commentCount||0).toLocaleString()} comments</span></details><div className="captionRow"><span>Caption translation</span><select value={captionLang} onChange={e=>{setCaptionLang(e.target.value);cc(e.target.value)}} disabled={!isPro} aria-label="Caption language"><option value="en">English</option><option value="zh-Hans">简体中文</option><option value="zh-Hant">繁體中文</option><option value="hi">हिन्दी</option><option value="ar">العربية</option><option value="fr">Français</option><option value="es">Español</option><option value="pt">Português</option></select>{!isPro&&<small>PRO</small>}</div>
   <div className="actionRow"><button onClick={like}>♡ {liked?"Liked":"Like"} {likes?likes:""}</button><button onClick={save}>{saved?"✓ Saved":"＋ Save"}</button><button onClick={share}>↗ Share</button><a className="softBtn" href={`https://www.youtube.com/watch?v=${video.id}`} target="_blank" rel="noreferrer">YouTube ↗</a></div>
   <OriginalityRating video={video} user={user} onNotice={onNotice}/>
  </div>
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
 async function checkout(){if(owner){onNotice("Owner access: Kivora Pro is free for this account.");return}if(!user||user.isAnonymous){onNotice("Connect Google before purchasing Pro.");return}setLoading(true);onNotice("Opening secure checkout…");setTimeout(()=>{if(!liveRef.current)return;setLoading(false);onNotice("Checkout endpoint is not configured yet. Add the server-side Flutterwave verification before accepting payment.");},500)}
 return <section className="panel pro"><small>KIVORA PRO</small><h1>More room for the stories you love.</h1><p>Pro is designed around convenience: translated caption controls where the embedded source provides captions, richer collections and an ad-reduced Kivora experience.</p><div className="proGrid"><div><b>Free</b><span>Core discovery · saved videos · original/source captions when available</span></div><div><b>Pro</b><span>Translated caption controls · expanded collections · fewer Kivora ads</span></div></div><button className="primary" onClick={checkout} disabled={loading}>{loading?"Opening…":owner?"Pro enabled for owner":"Continue to secure checkout"}</button><p className="tiny">{owner?"Owner billing bypass is enabled for the configured Kivora owner account.":"Payment is only granted after server-side verification. No client-side “paid” flag unlocks Pro."}</p></section>
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
 async function submit(e){e.preventDefault();if(submitting)return;setSubmitting(true);setStatus("");const result=preflight();if(result!=="PASS"){setStatus(result);setSubmitting(false);return;}setStatus(`Preflight passed. ${owner?"Owner billing bypass applies. No payment is required.":"Estimated bill: $"+estimatedBill.toFixed(2)+" for "+billableImpressions.toLocaleString()+" billable impressions ("+billableBlocks+" × 1,500 at $"+pricePerBlock.toFixed(2)+"). Final charge is created only after server-side validation."}`);setStep("review");setSubmitting(false);}
 if(step==="prep")return <section className="panel"><h1>Advertise with Kivora</h1><p>Every campaign goes through preflight checks before a bill is created. We store monitoring data separately from viewer actions and never count an ad impression as a YouTube view.</p><div className="steps"><div>1. Choose a format.</div><div>2. Provide a Drive asset ID or an approved YouTube URL.</div><div>3. Review the estimated bill before payment.</div><div>4. Server validates, bills and activates only after verification.</div></div><button className="primary" onClick={()=>setStep("formats")}>Choose format</button></section>;
 if(step==="formats")return <section className="panel"><button onClick={()=>setStep("prep")}>← Back</button><h1>Choose format</h1><div className="formatGrid"><button className="formatCard" onClick={()=>choose("square")}><b>Square banner</b><span>1080 × 1080 · Google Drive ID</span><strong>$1.99 / 1,500 impressions</strong></button><button className="formatCard" onClick={()=>choose("rectangle")}><b>Rectangle banner</b><span>1200 × 628 · Google Drive ID</span><strong>$1.99 / 1,500 impressions</strong></button><button className="formatCard" onClick={()=>choose("video")}><b>Video campaign</b><span>Google Drive ID or YouTube URL</span><strong>$2.99 / 1,500 impressions</strong></button></div></section>;
 if(step==="review")return <section className="panel"><button onClick={()=>setStep("form")}>← Edit campaign</button><h1>Bill preview</h1><div className="priceBox"><b>Estimated bill: ${estimatedBill.toFixed(2)}</b><span>{owner?"Owner rate: $0.00 (billing bypass)":`Rate: $${pricePerBlock.toFixed(2)} / 1,500 impressions`}</span><span>Target impressions: {targetImpressions.toLocaleString()}</span><span>Billable impressions: {billableImpressions.toLocaleString()}</span><span>Duration: {days} day{days===1?"":"s"}</span><small>{owner?"This account is exempt from Kivora advertising charges, but campaign validation and monitoring still apply.":"No payment should be captured until the server re-checks the campaign, asset access, price, currency, ownership and campaign status."}</small></div><button className="primary" onClick={()=>setStatus("Payment endpoint must create the checkout server-side. No charge has been attempted by this screen.")}>Continue to secure payment</button>{status&&<div className="status">{status}</div>}</section>;
 const meta={square:["Square banner","$1.99 / 1,500 impressions"],rectangle:["Rectangle banner","$1.99 / 1,500 impressions"],video:["Video campaign","$2.99 / 1,500 impressions"]}[format];
 return <section className="panel"><button onClick={()=>setStep("formats")}>← Change format</button><h1>{meta[0]}</h1><form onSubmit={submit}>{[["assetId",format==="video"?"Google Drive file ID or YouTube URL":"Google Drive file ID"],["brand","Brand name"],["title","Campaign title"],["description","Description"],["site","Destination URL"],["country","Target country"],["targetImpressions","Target impressions"],["duration","Campaign duration (days)"]].map(([k,l])=><label key={k}>{l}<input value={form[k]} onChange={e=>update(k,e.target.value)} required/></label>)}<div className="priceBox"><span>Rate <b>{owner?"$0.00 — owner billing bypass":"$"+pricePerBlock.toFixed(2)+" / 1,500 impressions"}</b></span><span>Billable impressions <b>{billableImpressions.toLocaleString()}</b></span><span>Estimated bill <b>${estimatedBill.toFixed(2)}</b></span><small>{owner?"No payment is required for the configured owner account. Campaign validation still applies.":"The bill is calculated before payment. It is not a final charge until the server validates it."}</small></div><button className="primary" disabled={submitting}>{submitting?"Checking…":"Review bill before payment"}</button></form>{status&&<div className="status">{status}</div>}</section>
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
  ["Can I open a video on YouTube?","Yes. Every video has a YouTube link, and the menu also provides a direct YouTube link for actions that belong on YouTube."],
  ["Are sponsored videos clearly marked?","Yes. Paid campaigns that pass Kivora's approval flow are shown in the FYP with a Sponsored label."],
  ["How much does advertising cost?","Image/banner placements are $1.99 per 1,500 impressions. Video advertising is $2.99 per 1,500 impressions. Final billing is server-authoritative."],
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
function authMessage(e){return e?.code==="auth/account-exists-with-different-credential"?"That Google account is already linked to another sign-in method.":e?.message||"Sign-in could not be completed."}

createRoot(document.getElementById("root")).render(<App/>);
