import { adminDb, optionalUser } from '../functions/server-auth.js';
import { calculateDeliveredSpend, updateAdMonitor, qualifiesVideoImpression } from '../functions/ad-engine.js';

function cleanId(v){return String(v||'').trim().replace(/[^A-Za-z0-9_-]/g,'').slice(0,128)}
function fail(res,e){return res.status(e?.statusCode||400).json({error:e?.message||'Request failed.'})}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method==='OPTIONS') return res.status(204).end();
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed.'});
  try{
    const user=await optionalUser(req);
    const body=req.body||{};
    const campaignId=cleanId(body.campaignId);
    const secondsViewed=Number(body.secondsViewed||0);
    const visibleRatio=Number(body.visibleRatio||0);
    const source=body.source==='drive'?'drive':'youtube';
    const impressionKey=cleanId(body.impressionKey);
    const viewerKey=cleanId(body.viewerKey || 'anonymous');
    if(!campaignId||!impressionKey) return res.status(400).json({error:'campaignId and impressionKey are required.'});
    if(!Number.isFinite(secondsViewed)||secondsViewed<0||!Number.isFinite(visibleRatio)||visibleRatio<0||visibleRatio>1) return res.status(400).json({error:'Invalid viewability data.'});
    const db=adminDb();
    const campaignRef=db.collection('campaigns').doc(campaignId);
    const eventRef=campaignRef.collection('impressionEvents').doc(impressionKey);
    const result=await db.runTransaction(async tx=>{
      const [campaignSnap,eventSnap]=await Promise.all([tx.get(campaignRef),tx.get(eventRef)]);
      if(!campaignSnap.exists) throw Object.assign(new Error('Campaign not found.'),{statusCode:404});
      const campaign=campaignSnap.data()||{};
      if(user?.uid && campaign.advertiserId===user.uid) return {qualified:false,reason:'advertiser_view_not_billable'};
      if(campaign.status!=='ready'||campaign.paymentStatus!=='verified'||campaign.moderationStatus!=='approved'||campaign.assetStatus!=='verified') return {qualified:false,reason:'campaign_not_active'};
      if(eventSnap.exists) return {qualified:false,reason:'already_counted'};
      const target=Math.max(0,Number(campaign.targetImpressions||0));
      if(target && Number(campaign.qualifiedImpressions||campaign.impressions||0)>=target) return {qualified:false,reason:'target_reached'};
      if(!qualifiesVideoImpression({secondsViewed,visibleRatio,alreadyCounted:false})) return {qualified:false,reason:'viewability_threshold_not_met'};
      const monitor=updateAdMonitor(campaign,{qualifiedImpressions:1,now:new Date().toISOString()});
      tx.set(eventRef,{userId:user?.uid||null,viewerKey,source,secondsViewed,visibleRatio,createdAt:new Date().toISOString()});
      tx.update(campaignRef,{...monitor,lastQualifiedImpressionAt:new Date().toISOString(),status:monitor.monitorStatus==='impression_target_reached'?'completed':'ready'});
      return {qualified:true,spend:calculateDeliveredSpend(monitor.billableImpressions),remainingImpressions:monitor.remainingImpressions,monitor};
    });
    return res.status(200).json(result);
  }catch(e){return fail(res,e)}
}
