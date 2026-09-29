import { adminDb, requireUser } from '../functions/server-auth.js';
import { calculateBillForUser, validatePromotion, MAX_TARGET_IMPRESSIONS, IMPRESSION_BLOCK_SIZE, USD_TO_NGN_RATE } from '../functions/ad-engine.js';
import { validateAsset } from '../functions/moderation.js';
import { createHostedPayment } from '../functions/flutterwave.js';
import { randomUUID } from 'node:crypto';

const YOUTUBE_ID=/^[A-Za-z0-9_-]{6,}$/;
const DRIVE_ID=/^[A-Za-z0-9_-]{20,}$/;
const YOUTUBE_URL=/^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)[A-Za-z0-9_-]{6,}/i;

function parseYouTubeId(value=''){
  const s=String(value).trim();
  if(YOUTUBE_ID.test(s)&&s.length<=20)return s;
  try{const u=new URL(s.startsWith('http')?s:`https://${s}`);if(u.hostname==='youtu.be'||u.hostname.endsWith('.youtu.be'))return u.pathname.split('/').filter(Boolean)[0]||'';if(u.hostname.includes('youtube.com'))return u.searchParams.get('v')||u.pathname.split('/').filter(Boolean).pop()||'';}catch{}
  return '';
}
function parseDriveId(value=''){
  const s=String(value).trim();
  if(DRIVE_ID.test(s)&&s.length>20)return s;
  const m=s.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?id=)([A-Za-z0-9_-]+)/i);
  return m?.[1]||'';
}
async function verifyAsset(assetId){
  const yt=parseYouTubeId(assetId);
  if(yt){
    const key=process.env.YOUTUBE_API_KEY;
    if(!key) throw new Error('YOUTUBE_API_KEY is required to verify a sponsored YouTube Short.');
    const p=new URLSearchParams({part:'snippet,contentDetails,status,player',id:yt,key,maxWidth:'1080',maxHeight:'1920'});
    const r=await fetch(`https://www.googleapis.com/youtube/v3/videos?${p}`); const d=await r.json();
    if(!r.ok||!d.items?.[0]) throw new Error('The YouTube video could not be verified.');
    const item=d.items[0], iso=item.contentDetails?.duration||'';
    const m=iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
    const duration=(Number(m?.[1]||0)*3600)+(Number(m?.[2]||0)*60)+Number(m?.[3]||0);
    const width=Number(item.player?.embedWidth||0), height=Number(item.player?.embedHeight||0);
    const publishedAt=String(item.snippet?.publishedAt||'');
    const uploadedAfterShortsRule=publishedAt && new Date(publishedAt).getTime() >= Date.UTC(2024,9,15);
    if(duration<=0||duration>180) throw new Error('Sponsored YouTube video must be 180 seconds or shorter.');
    if(!(width>0&&height>0&&width<=height)) throw new Error('Sponsored YouTube video must be square or vertical so YouTube classifies it as a Short.');
    if(!uploadedAfterShortsRule) throw new Error('This YouTube video predates the current Shorts classification rule and cannot be verified as a Short.');
    if(item.status?.embeddable===false) throw new Error('This YouTube video does not allow embedding.');
    return {source:'youtube',assetId:yt,durationSeconds:duration,title:item.snippet?.title||'',channelTitle:item.snippet?.channelTitle||'',publishedAt:item.snippet?.publishedAt||'',embedWidth:width,embedHeight:height};
  }
  const drive=parseDriveId(assetId);
  if(drive){
    // Kivora never downloads or stores this file. Playback uses Drive's hosted preview.
    const r=await fetch(`https://drive.google.com/file/d/${drive}/preview`,{redirect:'follow',headers:{'user-agent':'Kivora-AdVerifier/1.0'}});
    if(!r.ok) throw new Error('The Google Drive video could not be reached. Set the file to Anyone with the link and Viewer access.');
    return {source:'drive',assetId:drive,durationSeconds:0};
  }
  throw new Error('Video must be a YouTube URL/ID or Google Drive file ID/link.');
}

async function createCampaign(req,res){
  const user=await requireUser(req); const b=req.body||{};
  const promotionType=b.promotionType==='app'?'app':'short';
  validatePromotion({...b,promotionType});
  const target=Math.floor(Number(b.targetImpressions||0));
  const duration=Math.floor(Number(b.durationDays||b.duration||0));
  if(!Number.isInteger(target)||target<IMPRESSION_BLOCK_SIZE||target>MAX_TARGET_IMPRESSIONS) throw new Error(`Target impressions must be between ${IMPRESSION_BLOCK_SIZE.toLocaleString()} and ${MAX_TARGET_IMPRESSIONS.toLocaleString()}.`);
  if(!Number.isInteger(duration)||duration<1||duration>90) throw new Error('Campaign duration must be 1–90 days.');
  const startDate=String(b.startDate||'').slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error('A valid campaign start date is required.');
  if(!String(b.brand||'').trim()||!String(b.title||'').trim()) throw new Error('Brand and campaign title are required.');
  if(promotionType==='app'&&!/^https?:\/\//i.test(String(b.site||''))) throw new Error('App/site promotions require a valid destination URL.');
  if(promotionType==='app'&&!String(b.destinationName||'').trim()) throw new Error('App/site promotions require a destination name.');
  if(!validateAsset('video',String(b.assetId||''))) throw new Error('Invalid sponsored video source.');
  const asset=await verifyAsset(b.assetId);
  const bill=calculateBillForUser({targetImpressions:target,authenticatedEmail:user.email,format:'video'});
  const id=randomUUID();
  const end=new Date(`${startDate}T00:00:00`); end.setDate(end.getDate()+duration-1);
  const campaign={
    advertiserId:user.uid,advertiserEmail:user.email||'',promotionType,format:'video',brand:String(b.brand).trim().slice(0,120),title:String(b.title).trim().slice(0,160),description:String(b.description||'').trim().slice(0,500),country:String(b.country||'NG').trim().slice(0,10),assetId:asset.assetId,assetSource:asset.source,durationSeconds:asset.durationSeconds||null,embedWidth:asset.embedWidth||null,embedHeight:asset.embedHeight||null,publishedAt:asset.publishedAt||null,site:promotionType==='app'?String(b.site).trim():null,destinationName:promotionType==='app'?String(b.destinationName).trim().slice(0,80):null,siteIcon:promotionType==='app'?String(b.siteIcon||'').trim().slice(0,500):null,targetImpressions:target,billableImpressions:bill.billableImpressions,totalBudgetUsd:bill.total,totalBudgetNgn:bill.totalNgn,currency:'NGN',usdNgnRate:USD_TO_NGN_RATE,durationDays:duration,startDate,endDate:end.toISOString().slice(0,10),qualifiedImpressions:0,impressions:0,clicks:0,spend:0,status:bill.ownerBillingBypass?'ready':'pending_payment',paymentStatus:bill.ownerBillingBypass?'verified':'pending',moderationStatus:'approved',assetStatus:'verified',preflightStatus:'passed',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
  };
  const db=adminDb(); await db.collection('campaigns').doc(id).set(campaign);
  if(bill.ownerBillingBypass) return res.status(200).json({campaignId:id,paymentRequired:false,campaign});
  const payment=await createHostedPayment({email:user.email,name:user.name||user.email,campaignId:id,amountNgn:bill.totalNgn});
  await db.collection('campaigns').doc(id).update({paymentReference:payment.tx_ref,paymentLink:payment.link,updatedAt:new Date().toISOString()});
  return res.status(200).json({campaignId:id,paymentRequired:true,paymentLink:payment.link,amountNgn:bill.totalNgn,currency:'NGN'});
}

async function verifyPayment(req,res){
  const user=await requireUser(req); const b=req.body||{}; const id=String(b.campaignId||'').trim(); const transactionId=String(b.transactionId||'').trim();
  if(!id||!transactionId) throw new Error('campaignId and transactionId are required.');
  const db=adminDb(); const ref=db.collection('campaigns').doc(id); const snap=await ref.get();
  if(!snap.exists) return res.status(404).json({error:'Campaign not found.'});
  const campaign=snap.data()||{}; if(campaign.advertiserId!==user.uid) return res.status(403).json({error:'Campaign access denied.'});
  const verification=await verifyHostedPayment({transactionId,expectedReference:campaign.paymentReference,expectedAmount:campaign.totalBudgetNgn,expectedCurrency:'NGN'});
  if(!verification.success) return res.status(402).json({error:'Payment is not verified yet.',status:verification.status||'pending'});
  await ref.update({paymentStatus:'verified',status:'ready',paymentTransactionId:transactionId,paidAmount:verification.amount,updatedAt:new Date().toISOString()});
  return res.status(200).json({verified:true,campaignId:id});
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method==='OPTIONS') return res.status(204).end();
res.setHeader('Content-Type','application/json; charset=utf-8');try{if(req.method!=='POST')return res.status(405).json({error:'Method not allowed.'});if(req.query?.action==='verify')return await verifyPayment(req,res);return await createCampaign(req,res)}catch(e){return res.status(e?.statusCode||400).json({error:e?.message||'Campaign request failed.'})}}
