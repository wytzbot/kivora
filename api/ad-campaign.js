import { adminDb, requireUser } from '../functions/server-auth.js';
import { calculateBillForUser, validatePromotion, MAX_TARGET_IMPRESSIONS, IMPRESSION_BLOCK_SIZE, MIN_TARGET_IMPRESSIONS, USD_TO_NGN_RATE } from '../functions/ad-engine.js';
import { validateAsset } from '../functions/moderation.js';
import { createHostedPayment, verifyHostedPayment } from '../functions/flutterwave.js';
import { randomUUID } from 'node:crypto';

const YOUTUBE_ID=/^[A-Za-z0-9_-]{6,}$/;
const YOUTUBE_URL=/^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)[A-Za-z0-9_-]{6,}/i;

function parseYouTubeId(value=''){
  const s=String(value).trim();
  if(YOUTUBE_ID.test(s)&&s.length<=20)return s;
  try{const u=new URL(s.startsWith('http')?s:`https://${s}`);if(u.hostname==='youtu.be'||u.hostname.endsWith('.youtu.be'))return u.pathname.split('/').filter(Boolean)[0]||'';if(u.hostname.includes('youtube.com'))return u.searchParams.get('v')||u.pathname.split('/').filter(Boolean).pop()||'';}catch{}
  return '';
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
  throw new Error('Video must already be published on YouTube. Paste a valid YouTube Shorts/video URL or ID.');
}

// Icon is either a small uploaded image (data URL, resized client-side) or an https URL.
function cleanIcon(value){
  const v=String(value||'').trim();
  if(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v)&&v.length<=60000) return v;
  if(/^https:\/\//i.test(v)&&v.length<=500) return v;
  return '';
}

async function cancelCampaign(req,res){
  const user=await requireUser(req); const id=String((req.body||{}).campaignId||'').trim();
  if(!id) throw new Error('campaignId is required.');
  const db=adminDb(); const ref=db.collection('campaigns').doc(id);
  const result=await db.runTransaction(async tx=>{
    const snap=await tx.get(ref);
    if(!snap.exists) return {code:404,error:'Campaign not found.'};
    const c=snap.data()||{};
    if(c.advertiserId!==user.uid) return {code:403,error:'Campaign access denied.'};
    if(c.status==='cancelled') return {code:200,already:true};
    if(c.status==='completed') return {code:409,error:'This campaign has already completed.'};
    const now=new Date().toISOString();
    // Delivery, the feed query and the impression endpoint all require status "ready", so this stops serving immediately.
    tx.update(ref,{status:'cancelled',cancelledAt:now,cancelledBy:user.uid,statusBeforeCancel:c.status||'',updatedAt:now});
    return {code:200,already:false};
  });
  if(result.code!==200) return res.status(result.code).json({error:result.error});
  return res.status(200).json({cancelled:true,campaignId:id,alreadyCancelled:!!result.already});
}

async function createCampaign(req,res){
  const user=await requireUser(req); const b=req.body||{};
  const promotionType=b.promotionType==='app'?'app':'short';
  validatePromotion({...b,promotionType});
  const target=Math.floor(Number(b.targetImpressions||0));
  const duration=Math.floor(Number(b.durationDays||b.duration||0));
  if(!Number.isInteger(target)||target<MIN_TARGET_IMPRESSIONS||target>MAX_TARGET_IMPRESSIONS) throw new Error(`Target impressions must be between ${MIN_TARGET_IMPRESSIONS.toLocaleString()} and ${MAX_TARGET_IMPRESSIONS.toLocaleString()}.`);
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
  const end=new Date(`${startDate}T00:00:00Z`); end.setUTCDate(end.getUTCDate()+duration-1);
  const campaign={
    advertiserId:user.uid,advertiserEmail:user.email||'',promotionType,targetCategories:Array.isArray(b.categories)?[...new Set(b.categories.map(x=>String(x).toLowerCase()).filter(x=>['all','comedy','tech','adventure','science','finance','education','gaming','sports','food','music','beauty','new'].includes(x)))].slice(0,13):['all'],targetLocation:['all','country','city'].includes(String(b.targetLocation||'all'))?String(b.targetLocation||'all'):'all',targetRegion:String(b.targetLocationValue||b.country||'').trim().slice(0,100),format:'video',brand:String(b.brand).trim().slice(0,120),title:String(b.title).trim().slice(0,160),description:String(b.description||'').trim().slice(0,500),country:String(b.country||'NG').trim().slice(0,10),assetId:asset.assetId,assetSource:asset.source,durationSeconds:asset.durationSeconds||null,embedWidth:asset.embedWidth||null,embedHeight:asset.embedHeight||null,publishedAt:asset.publishedAt||null,site:promotionType==='app'?String(b.site).trim():null,destinationName:promotionType==='app'?String(b.destinationName).trim().slice(0,80):null,siteIcon:promotionType==='app'?cleanIcon(b.siteIcon):null,targetImpressions:target,billableImpressions:bill.billableImpressions,totalBudgetUsd:bill.total,totalBudgetNgn:bill.totalNgn,currency:'NGN',usdNgnRate:USD_TO_NGN_RATE,durationDays:duration,startDate,endDate:end.toISOString().slice(0,10),qualifiedImpressions:0,impressions:0,clicks:0,spend:0,status:bill.ownerBillingBypass?'ready':'pending_payment',paymentStatus:bill.ownerBillingBypass?'verified':'pending',moderationStatus:'approved',assetStatus:'verified',preflightStatus:'passed',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
  };
  const db=adminDb(); await db.collection('campaigns').doc(id).set(campaign);
  if(bill.ownerBillingBypass) return res.status(200).json({campaignId:id,paymentRequired:false,campaign});
  const payment=await createHostedPayment({email:user.email,name:user.name||user.email,campaignId:id,amountNgn:bill.totalNgn});
  await db.collection('campaigns').doc(id).update({paymentReference:payment.tx_ref,paymentLink:payment.link,paymentChargeId:payment.chargeId||'',updatedAt:new Date().toISOString()});
  return res.status(200).json({campaignId:id,paymentRequired:true,paymentLink:payment.link,amountNgn:bill.totalNgn,currency:'NGN'});
}

async function verifyPayment(req,res){
  const user=await requireUser(req); const b=req.body||{}; const id=String(b.campaignId||'').trim(); let transactionId=String(b.transactionId||'').trim();
  if(!id) throw new Error('campaignId is required.');
  const db=adminDb(); const ref=db.collection('campaigns').doc(id); const snap=await ref.get();
  if(!snap.exists) return res.status(404).json({error:'Campaign not found.'});
  const campaign=snap.data()||{}; if(campaign.advertiserId!==user.uid) return res.status(403).json({error:'Campaign access denied.'});
  if(campaign.status==='cancelled') return res.status(409).json({error:'This campaign was cancelled.'});
  if(campaign.paymentStatus==='verified') return res.status(200).json({verified:true,campaignId:id});
  // v4 charges are verified by the charge id stored when the checkout was created.
  if(campaign.paymentChargeId) transactionId=campaign.paymentChargeId;
  if(!transactionId) return res.status(402).json({error:'Payment is not verified yet.',status:'pending'});
  const verification=await verifyHostedPayment({transactionId,expectedReference:campaign.paymentReference,expectedAmount:campaign.totalBudgetNgn,expectedCurrency:'NGN'});
  if(!verification.success) return res.status(402).json({error:'Payment is not verified yet.',status:verification.status||'pending'});
  await ref.update({paymentStatus:'verified',status:'ready',paymentTransactionId:transactionId,paidAmount:verification.amount,updatedAt:new Date().toISOString()});
  return res.status(200).json({verified:true,campaignId:id});
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method==='OPTIONS') return res.status(204).end();
res.setHeader('Content-Type','application/json; charset=utf-8');try{if(req.method!=='POST')return res.status(405).json({error:'Method not allowed.'});if(req.query?.action==='verify')return await verifyPayment(req,res);if(req.query?.action==='cancel')return await cancelCampaign(req,res);return await createCampaign(req,res)}catch(e){return res.status(e?.statusCode||400).json({error:e?.message||'Campaign request failed.'})}}
