// Deterministic first-pass advertising moderation and asset validation.
// Final moderation, asset ownership/access and billing must be repeated server-side.
const blockedAdult=['porn','pornography','xxx','escort','onlyfans','nude','nudes','adult content'];
const blockedPolitical=['vote','election','candidate','political party','campaign','ballot','president','governor','senator','politician','electoral'];
const driveId=/^[A-Za-z0-9_-]{20,}$/;
const youtube=/^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[A-Za-z0-9_-]{6,}/i;

export function validateAsset(format, asset){
 const value=(asset||'').trim();
 if(format==='video') return driveId.test(value)||youtube.test(value);
 return driveId.test(value)||/^https?:\/\//i.test(value);
}

export function moderateCampaign(campaign){
 const text=Object.values(campaign||{}).join(' ').toLowerCase();
 if(blockedAdult.some(x=>text.includes(x))) return {allowed:false,reason:'adult_content'};
 if(blockedPolitical.some(x=>text.includes(x))) return {allowed:false,reason:'political_advertising'};
 if(!/^https?:\/\//i.test(campaign?.site||'')) return {allowed:false,reason:'invalid_site'};
 if(!validateAsset(campaign?.format,campaign?.assetId||campaign?.youtube)) return {allowed:false,reason:'invalid_asset'};
 return {allowed:true};
}
