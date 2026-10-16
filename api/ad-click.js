import { adminDb, optionalUser } from '../functions/server-auth.js';
import { createHash } from 'node:crypto';

function clean(v){return String(v||'').trim().replace(/[^A-Za-z0-9_-]/g,'').slice(0,128)}
export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method==='OPTIONS')return res.status(204).end();
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed.'});
  try{
    const user=await optionalUser(req);
    const body=req.body||{};
    const campaignId=clean(body.campaignId);
    if(!campaignId)return res.status(400).json({error:'campaignId is required.'});
    const db=adminDb();
    const campaignRef=db.collection('campaigns').doc(campaignId);
    const campaignSnap=await campaignRef.get();
    if(!campaignSnap.exists)return res.status(404).json({error:'Campaign not found.'});
    const campaign=campaignSnap.data()||{};
    if(!['ready','completed'].includes(campaign.status)||campaign.moderationStatus!=='approved'||campaign.assetSource!=='youtube'){
      return res.status(200).json({recorded:false,reason:'campaign_not_clickable'});
    }
    // A double tap or banner re-render inside the same minute counts as one click.
    const forwarded=String(req.headers?.['x-forwarded-for']||'').split(',')[0].trim();
    const viewer=user?.uid?`u:${user.uid}`:`ip:${forwarded||req.socket?.remoteAddress||'unknown'}`;
    const clickId=createHash('sha256').update(`${campaignId}|${viewer}|${Math.floor(Date.now()/60000)}`).digest('hex').slice(0,40);
    const eventRef=campaignRef.collection('clickEvents').doc(clickId);
    await db.runTransaction(async tx=>{
      const fresh=await tx.get(campaignRef);
      if(!fresh.exists)throw new Error('Campaign not found.');
      const data=fresh.data()||{};
      if((await tx.get(eventRef)).exists)return;
      tx.set(eventRef,{userId:user?.uid||null,placement:String(body.placement||'shorts-banner').slice(0,40),destinationHost:hostOnly(data.site),createdAt:new Date().toISOString()});
      tx.update(campaignRef,{clicks:Math.max(0,Number(data.clicks||0))+1,lastClickAt:new Date().toISOString()});
    });
    return res.status(200).json({recorded:true});
  }catch(e){return res.status(500).json({error:e?.message||'Could not record ad click.'})}
}
function hostOnly(value){try{return new URL(String(value||'')).hostname.slice(0,253)}catch{return ''}}
