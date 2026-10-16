import { adminDb, requireUser } from '../functions/server-auth.js';
import { calculateBillForUser, validatePromotion, MAX_TARGET_IMPRESSIONS, IMPRESSION_BLOCK_SIZE, MIN_TARGET_IMPRESSIONS, USD_TO_NGN_RATE } from '../functions/ad-engine.js';
import { validateAsset } from '../functions/moderation.js';
import { createCardCharge, authorizeCharge, verifyCharge, nextStep, newReference, cleanCard } from '../functions/flutterwave.js';
import { FieldValue } from 'firebase-admin/firestore';
import { randomUUID, createHash } from 'node:crypto';

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

async function cancelUnpaid(req,res){
  const user=await requireUser(req); const db=adminDb();
  const snap=await db.collection('campaigns').where('advertiserId','==',user.uid).where('status','==','pending_payment').get();
  const now=new Date().toISOString(); const batch=db.batch(); const ids=[];
  snap.docs.forEach(d=>{const c=d.data()||{};if(c.paymentStatus!=='verified'){batch.update(d.ref,{status:'cancelled',cancelledAt:now,cancelledBy:user.uid,cancelReason:'unpaid_cleared',statusBeforeCancel:'pending_payment',updatedAt:now});ids.push(d.id)}});
  if(ids.length)await batch.commit();
  return {cancelled:ids};
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
  // Idempotency: the same campaign request must never create a second campaign (retries, double taps, app restarts).
  // A per-user draft lock document is read and written inside one Firestore transaction, so two simultaneous requests
  // are serialised: the second one receives the first one's campaign instead of creating its own.
  const fingerprint=createHash('sha256').update(JSON.stringify([user.uid,Object.keys(b).sort().map(k=>[k,b[k]])])).digest('hex');
  const db=adminDb();
  const id=randomUUID();
  const end=new Date(`${startDate}T00:00:00Z`); end.setUTCDate(end.getUTCDate()+duration-1);
  const nowIso=new Date().toISOString();
  const campaign={
    fingerprint,advertiserId:user.uid,advertiserEmail:user.email||'',promotionType,targetCategories:Array.isArray(b.categories)?[...new Set(b.categories.map(x=>String(x).toLowerCase()).filter(x=>['all','comedy','tech','adventure','science','finance','education','gaming','sports','food','music','beauty','new'].includes(x)))].slice(0,13):['all'],targetLocation:['all','country','city'].includes(String(b.targetLocation||'all'))?String(b.targetLocation||'all'):'all',targetRegion:String(b.targetLocationValue||b.country||'').trim().slice(0,100),format:'video',brand:String(b.brand).trim().slice(0,120),title:String(b.title).trim().slice(0,160),description:String(b.description||'').trim().slice(0,500),country:String(b.country||'NG').trim().slice(0,10),assetId:asset.assetId,assetSource:asset.source,durationSeconds:asset.durationSeconds||null,embedWidth:asset.embedWidth||null,embedHeight:asset.embedHeight||null,publishedAt:asset.publishedAt||null,site:promotionType==='app'?String(b.site).trim():null,destinationName:promotionType==='app'?String(b.destinationName).trim().slice(0,80):null,siteIcon:promotionType==='app'?cleanIcon(b.siteIcon):null,targetImpressions:target,billableImpressions:bill.billableImpressions,totalBudgetUsd:bill.total,totalBudgetNgn:bill.totalNgn,currency:'NGN',usdNgnRate:USD_TO_NGN_RATE,durationDays:duration,startDate,endDate:end.toISOString().slice(0,10),qualifiedImpressions:0,impressions:0,clicks:0,spend:0,status:bill.ownerBillingBypass?'ready':'pending_payment',paymentStatus:bill.ownerBillingBypass?'verified':'pending',moderationStatus:'approved',assetStatus:'verified',preflightStatus:'passed',createdAt:nowIso,updatedAt:nowIso
  };
  const lockRef=db.collection('campaignDrafts').doc(`${user.uid}_${fingerprint.slice(0,40)}`);
  const campaignRef=db.collection('campaigns').doc(id);
  const outcome=await db.runTransaction(async tx=>{
    const lock=await tx.get(lockRef);
    if(lock.exists){
      const existingId=String(lock.data()?.campaignId||'');
      if(existingId){
        const exSnap=await tx.get(db.collection('campaigns').doc(existingId));
        const ex=exSnap.exists?exSnap.data():null;
        if(ex&&ex.advertiserId===user.uid){
          if(ex.status==='pending_payment'&&ex.paymentStatus!=='verified')return {reuse:true,id:existingId,campaign:ex};
          // Owner (no payment step): a double tap within a minute returns the campaign that was just created.
          if(bill.ownerBillingBypass&&ex.status==='ready'&&Date.now()-Date.parse(ex.createdAt||0)<60000)return {reuse:true,id:existingId,campaign:ex};
        }
      }
    }
    tx.set(campaignRef,campaign);
    tx.set(lockRef,{campaignId:id,advertiserId:user.uid,createdAt:nowIso});
    return {reuse:false,id,campaign};
  });
  if(!bill.ownerBillingBypass){
    // Abandoned unpaid drafts (never charged) are cancelled so they do not pile up. Drafts created in the last few seconds
    // are left alone so two different in-flight requests can never cancel each other.
    const stale=await db.collection('campaigns').where('advertiserId','==',user.uid).where('status','==','pending_payment').get();
    const cutoff=Date.now()-8000; const batch=db.batch(); let n=0;
    stale.docs.forEach(d=>{const c=d.data()||{};if(d.id!==outcome.id&&!c.paymentChargeId&&c.paymentStatus!=='verified'&&Date.parse(c.createdAt||0)<cutoff){batch.update(d.ref,{status:'cancelled',cancelledAt:nowIso,cancelledBy:user.uid,cancelReason:'superseded_unpaid',statusBeforeCancel:'pending_payment',updatedAt:nowIso});n++}});
    if(n)await batch.commit();
  }
  if(bill.ownerBillingBypass) return res.status(200).json({campaignId:outcome.id,paymentRequired:false,campaign:outcome.campaign,reused:outcome.reuse});
  return res.status(200).json({campaignId:outcome.id,paymentRequired:true,amountNgn:outcome.campaign.totalBudgetNgn||bill.totalNgn,currency:'NGN',reused:outcome.reuse});
}

async function loadOwnCampaign(req,id){
  const user=await requireUser(req);
  if(!id) throw new Error('campaignId is required.');
  const ref=adminDb().collection('campaigns').doc(id); const snap=await ref.get();
  if(!snap.exists){const e=new Error('Campaign not found.');e.statusCode=404;throw e}
  const campaign=snap.data()||{};
  if(campaign.advertiserId!==user.uid){const e=new Error('Campaign access denied.');e.statusCode=403;throw e}
  if(campaign.status==='cancelled'){const e=new Error('This campaign was cancelled.');e.statusCode=409;throw e}
  return {user,ref,campaign};
}

function paymentReturnOrigin(req){
  const configured=String(process.env.KIVORA_PAYMENT_REDIRECT_URL||'').trim();
  if(configured)return configured.replace(/\/$/,'');
  // Inside the Android app the browser Origin is https://localhost (or capacitor://localhost). A bank page can never
  // redirect back to that address, so it is never used as a return URL.
  const origin=String(req.headers?.origin||'').trim();
  if(/^https:\/\/[^/]+$/i.test(origin)&&!/localhost|127\.0\.0\.1|capacitor/i.test(origin))return origin;
  if(process.env.VERCEL_PROJECT_PRODUCTION_URL)return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if(process.env.VERCEL_URL)return `https://${process.env.VERCEL_URL}`;
  return 'https://kivora-ecru.vercel.app';
}

// Charges Kivora has started for this campaign, newest first (also understands campaigns created before paymentCharges existed).
function chargeList(c){
  const list=[...(Array.isArray(c.paymentCharges)?c.paymentCharges:[])].reverse().map(x=>({chargeId:String(x.chargeId||''),reference:String(x.reference||'')}));
  if(c.paymentChargeId&&!list.some(x=>x.chargeId===String(c.paymentChargeId)))list.push({chargeId:String(c.paymentChargeId),reference:String(c.paymentReference||'')});
  return list.filter(x=>x.chargeId&&x.reference).slice(0,6);
}

// Re-fetch the charge from Flutterwave and activate the campaign only if reference, amount and currency match.
// Activation happens inside a transaction so a webhook and a manual check can never both "win" or double-apply.
async function settle(ref,campaign,chargeId,reference){
  const v=await verifyCharge({chargeId,expectedReference:reference||campaign.paymentReference,expectedAmount:campaign.totalBudgetNgn,expectedCurrency:'NGN'});
  if(!v.success) return v;
  const now=new Date().toISOString();
  await adminDb().runTransaction(async tx=>{
    const snap=await tx.get(ref); const c=snap.data()||{};
    if(c.paymentStatus==='verified'){
      // A second successful charge for the same campaign: keep the first, flag the extra one for refund.
      if(String(c.paymentTransactionId||'')!==String(chargeId))tx.update(ref,{duplicatePaymentChargeIds:FieldValue.arrayUnion(String(chargeId)),refundReview:true,updatedAt:now});
      return;
    }
    const base={paymentStatus:'verified',paymentTransactionId:String(chargeId),paymentReference:v.reference,paidAmount:v.amount,paymentVerifiedAt:now,paymentInFlightUntil:0,updatedAt:now};
    // Paid after the advertiser cancelled: never serve it, but record that money is owed back.
    if(c.status==='cancelled')tx.update(ref,{...base,refundRequired:true});
    else tx.update(ref,{...base,status:'ready'});
  });
  return v;
}

function stepResponse(res,campaignId,charge,extra={}){
  const s=nextStep(charge);
  return res.status(200).json({campaignId,...s,...extra});
}

// Claims the next payment attempt for a campaign. Only one attempt can be in flight at a time (double taps, two devices,
// retries) and attempts are counted before the card is charged, so declined cards also count toward the limit.
async function reservePaymentAttempt(ref,uid){
  return adminDb().runTransaction(async tx=>{
    const snap=await tx.get(ref);
    if(!snap.exists)throw Object.assign(new Error('Campaign not found.'),{statusCode:404});
    const c=snap.data()||{};
    if(c.advertiserId!==uid)throw Object.assign(new Error('Campaign access denied.'),{statusCode:403});
    if(c.status==='cancelled')throw Object.assign(new Error('This campaign was cancelled.'),{statusCode:409});
    if(c.paymentStatus==='verified')return {already:true,campaign:c};
    const now=Date.now();
    if(Number(c.paymentInFlightUntil||0)>now)throw Object.assign(new Error('A payment is already being processed for this campaign. Wait a few seconds, then tap Check payment status.'),{statusCode:409});
    const attempts=Number(c.paymentAttempts||0);
    if(attempts>=5)throw Object.assign(new Error('Too many payment attempts for this campaign. Create a new campaign or contact support.'),{statusCode:429});
    const reference=newReference();
    tx.update(ref,{paymentAttempts:attempts+1,paymentInFlightUntil:now+60000,paymentReference:reference,paymentReferences:FieldValue.arrayUnion(reference),updatedAt:new Date().toISOString()});
    return {already:false,reference,attempt:attempts+1,campaign:c};
  });
}

// Step 1: card details -> charge. Amount always comes from the stored campaign, never from the browser.
async function payCampaign(req,res){
  const b=req.body||{}; const id=String(b.campaignId||'').trim();
  const user=await requireUser(req);
  if(!id)throw new Error('campaignId is required.');
  cleanCard(b.card); // bad card numbers are rejected before an attempt is used up
  const ref=adminDb().collection('campaigns').doc(id);
  const claim=await reservePaymentAttempt(ref,user.uid);
  if(claim.already)return res.status(200).json({step:'success',campaignId:id});
  const {reference,campaign}=claim;
  const redirectUrl=`${paymentReturnOrigin(req)}/?payment=campaign&campaignId=${encodeURIComponent(id)}`;
  let chargeId,charge;
  try{
    ({chargeId,charge}=await createCardCharge({email:user.email,name:user.name||user.email,reference,amountNgn:campaign.totalBudgetNgn,redirectUrl,card:b.card,idempotencyKey:reference}));
  }catch(e){
    await ref.update({paymentInFlightUntil:0,lastPaymentError:String(e?.message||'').slice(0,200),updatedAt:new Date().toISOString()}).catch(()=>{});
    throw e;
  }
  await ref.update({paymentChargeId:chargeId,paymentCharges:FieldValue.arrayUnion({chargeId,reference,at:new Date().toISOString()}),paymentLink:null,paymentInFlightUntil:0,updatedAt:new Date().toISOString()});
  const next=nextStep(charge);
  if(next.step==='success'){const v=await settle(ref,{...campaign,paymentReference:reference},chargeId,reference); if(v.success) return res.status(200).json({step:'success',campaignId:id})}
  return res.status(200).json({campaignId:id,...next});
}

// Step 2/3: PIN or OTP for the charge already stored on the campaign.
async function authorizePayment(req,res){
  const b=req.body||{}; const id=String(b.campaignId||'').trim();
  const {ref,campaign}=await loadOwnCampaign(req,id);
  if(campaign.paymentStatus==='verified') return res.status(200).json({step:'success',campaignId:id});
  if(!campaign.paymentChargeId) return res.status(409).json({error:'Start the card payment first.'});
  const authAttempts=Number(campaign.authorizeAttempts||0);
  if(authAttempts>=8) return res.status(429).json({error:'Too many PIN/OTP attempts. Start a new card payment.'});
  await ref.update({authorizeAttempts:authAttempts+1});
  const type=b.type==='otp'?'otp':'pin';
  const charge=await authorizeCharge({chargeId:campaign.paymentChargeId,type,pin:b.pin,code:b.code,idempotencyKey:`${campaign.paymentChargeId}-${type}-${authAttempts+1}`});
  const next=nextStep(charge);
  if(next.step==='success'){const v=await settle(ref,campaign,campaign.paymentChargeId,campaign.paymentReference); if(v.success) return res.status(200).json({step:'success',campaignId:id})}
  return res.status(200).json({campaignId:id,...next});
}

// Fallback / 3-D Secure return: poll the real charge status. Every charge started for the campaign is checked,
// so a bank that confirms an earlier attempt late still activates the campaign.
async function verifyPayment(req,res){
  const b=req.body||{}; const id=String(b.campaignId||'').trim();
  const {ref,campaign}=await loadOwnCampaign(req,id);
  if(campaign.paymentStatus==='verified') return res.status(200).json({verified:true,campaignId:id});
  const charges=chargeList(campaign);
  if(!charges.length) return res.status(402).json({error:'Payment is not verified yet.',status:'pending'});
  let latest=null;
  for(const c of charges){
    const v=await settle(ref,campaign,c.chargeId,c.reference);
    if(v.success) return res.status(200).json({verified:true,campaignId:id});
    if(!latest)latest=v;
  }
  const failed=latest?.status==='failed';
  return res.status(402).json({error:failed?'The payment failed. Please try again with the card form.':'Payment is not verified yet.',status:latest?.status||'pending'});
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method==='OPTIONS') return res.status(204).end();
res.setHeader('Content-Type','application/json; charset=utf-8');try{if(req.method!=='POST')return res.status(405).json({error:'Method not allowed.'});if(req.query?.action==='pay')return await payCampaign(req,res);if(req.query?.action==='authorize')return await authorizePayment(req,res);if(req.query?.action==='verify')return await verifyPayment(req,res);if(req.query?.action==='cancel-unpaid')return res.status(200).json(await cancelUnpaid(req,res));if(req.query?.action==='cancel')return await cancelCampaign(req,res);return await createCampaign(req,res)}catch(e){return res.status(e?.statusCode||400).json({error:e?.message||'Campaign request failed.'})}}
