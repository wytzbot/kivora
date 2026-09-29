import { requireUser } from '../functions/server-auth.js';

const API='https://www.googleapis.com/youtube/v3';
const VIDEO_ID=/^[A-Za-z0-9_-]{6,}$/;

function fail(res,error,status=400){return res.status(error?.statusCode||status).json({error:error?.message||'YouTube action failed.'})}
function cleanId(v){const id=String(v||'').trim();return VIDEO_ID.test(id)?id:''}
function authHeaders(token){return {Authorization:`Bearer ${token}`,Accept:'application/json','Content-Type':'application/json'}}
async function yt(url,options={}){
 const r=await fetch(url,options);let d={};try{d=await r.json()}catch{}
 if(!r.ok){const reason=d?.error?.errors?.[0]?.reason;const msg=d?.error?.message||'YouTube API request failed.';throw Object.assign(new Error(reason?`${msg} (${reason})`:msg),{statusCode:r.status,reason})}
 return d;
}

async function publicStats(videoId){
 const key=process.env.YOUTUBE_API_KEY;
 if(!key)return {};
 const p=new URLSearchParams({part:'statistics',id:videoId,key});
 const d=await yt(`${API}/videos?${p}`);
 const s=d?.items?.[0]?.statistics||{};
 return {likes:Number(s.likeCount||0),comments:Number(s.commentCount||0)};
}

async function getRating(videoId,accessToken){
 const p=new URLSearchParams({part:'id',id:videoId});
 const d=await yt(`${API}/videos/getRating?${p}`,{headers:authHeaders(accessToken)});
 return d?.items?.[0]?.rating||'none';
}

async function findKivoraPlaylist(accessToken){
 const p=new URLSearchParams({part:'snippet',mine:'true',maxResults:'50'});
 let page='';
 do{
   if(page)p.set('pageToken',page);
   const d=await yt(`${API}/playlists?${p}`,{headers:authHeaders(accessToken)});
   const found=(d.items||[]).find(x=>String(x?.snippet?.title||'').trim().toLowerCase()==='kivora saves');
   if(found)return found.id;
   page=d.nextPageToken||'';
 }while(page);
 const body={snippet:{title:'Kivora Saves',description:'Private saves created from Kivora. Managed through your YouTube account.'},status:{privacyStatus:'private'}};
 const created=await yt(`${API}/playlists?part=snippet,status`,{method:'POST',headers:authHeaders(accessToken),body:JSON.stringify(body)});
 return created.id;
}

async function findSavedItem(playlistId,videoId,accessToken){
 const p=new URLSearchParams({part:'id',playlistId,videoId,maxResults:'50'});
 const d=await yt(`${API}/playlistItems?${p}`,{headers:authHeaders(accessToken)});
 return d?.items?.[0]?.id||'';
}

async function saveVideo(videoId,accessToken,wantSaved){
 const playlistId=await findKivoraPlaylist(accessToken);
 const existing=await findSavedItem(playlistId,videoId,accessToken);
 if(wantSaved){
   if(!existing){
     await yt(`${API}/playlistItems?part=snippet`,{method:'POST',headers:authHeaders(accessToken),body:JSON.stringify({snippet:{playlistId,resourceId:{kind:'youtube#video',videoId}}})});
   }
   return {saved:true};
 }
 if(existing)await yt(`${API}/playlistItems?id=${encodeURIComponent(existing)}`,{method:'DELETE',headers:authHeaders(accessToken)});
 return {saved:false};
}

async function postComment(videoId,text,accessToken){
 const details=await yt(`${API}/videos?part=snippet&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(process.env.YOUTUBE_API_KEY||'')}`);
 const item=details?.items?.[0];
 if(!item)throw new Error('Video not found on YouTube.');
 const channelId=item?.snippet?.channelId;
 if(!channelId)throw new Error('The YouTube channel could not be resolved.');
 const body={snippet:{channelId,videoId,topLevelComment:{snippet:{textOriginal:text}}}};
 const created=await yt(`${API}/commentThreads?part=snippet`,{method:'POST',headers:authHeaders(accessToken),body:JSON.stringify(body)});
 const c=created?.snippet?.topLevelComment?.snippet||{};
 return {comment:{id:created.id,author:c?.authorDisplayName||'YouTube user',text:c?.textDisplay||c?.textOriginal||text}};
}

async function listComments(videoId,pageToken=''){
 const key=process.env.YOUTUBE_API_KEY;
 if(!key)throw new Error('YOUTUBE_API_KEY is not configured.');
 const p=new URLSearchParams({part:'snippet',videoId,maxResults:'20',order:'relevance',key});
 if(pageToken)p.set('pageToken',pageToken);
 const d=await yt(`${API}/commentThreads?${p}`);
 return {items:(d.items||[]).map(x=>({id:x.id,author:x?.snippet?.topLevelComment?.snippet?.authorDisplayName||'YouTube user',text:x?.snippet?.topLevelComment?.snippet?.textDisplay||''})),nextPageToken:d.nextPageToken||''};
}

export default async function handler(req,res){
 res.setHeader('Content-Type','application/json; charset=utf-8');
 res.setHeader('Cache-Control','no-store');
 try{
   const videoId=cleanId(req.query?.videoId||req.body?.videoId);
   if(!videoId)return res.status(400).json({error:'A valid YouTube videoId is required.'});
   if(req.method==='GET')return res.status(200).json(await listComments(videoId,String(req.query?.pageToken||'')));
   if(req.method!=='POST')return res.status(405).json({error:'Method not allowed.'});
   await requireUser(req);
   const accessToken=String(req.body?.accessToken||'').trim();
   if(!accessToken)return res.status(401).json({error:'YouTube permission is required. Connect your YouTube account first.'});
   const action=String(req.body?.action||'').trim().toLowerCase();
   if(action==='like'){
     const before=await getRating(videoId,accessToken);
     const rating=req.body?.rating==='none' ? 'none' : (before==='like' ? 'none' : 'like');
     await yt(`${API}/videos/rate?id=${encodeURIComponent(videoId)}&rating=${rating}`,{method:'POST',headers:{Authorization:`Bearer ${accessToken}`,Accept:'application/json'}});
     const [currentRating,statistics]=await Promise.all([getRating(videoId,accessToken),publicStats(videoId)]);
     return res.status(200).json({rating:currentRating,statistics});
   }
   if(action==='save'){
     const playlistId=await findKivoraPlaylist(accessToken);
     const existing=await findSavedItem(playlistId,videoId,accessToken);
     const wantSaved=!existing;
     if(wantSaved){
       await yt(`${API}/playlistItems?part=snippet`,{method:'POST',headers:authHeaders(accessToken),body:JSON.stringify({snippet:{playlistId,resourceId:{kind:'youtube#video',videoId}}})});
     }else{
       await yt(`${API}/playlistItems?id=${encodeURIComponent(existing)}`,{method:'DELETE',headers:authHeaders(accessToken)});
     }
     return res.status(200).json({saved:wantSaved});
   }
   if(action==='comment'){
     const text=String(req.body?.text||'').trim();
     if(!text||text.length>10000)return res.status(400).json({error:'Comment must contain 1–10,000 characters.'});
     const result=await postComment(videoId,text,accessToken);
     result.statistics=await publicStats(videoId);
     return res.status(200).json(result);
   }
   if(action==='status'){
     const [rating,statistics]=await Promise.all([getRating(videoId,accessToken),publicStats(videoId)]);
     return res.status(200).json({rating,statistics});
   }
   return res.status(400).json({error:'Unsupported YouTube action.'});
 }catch(e){return fail(res,e)}
}
