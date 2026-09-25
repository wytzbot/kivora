// New-video notification policy.
// A trusted backend should call this after catalog ingestion, not the browser.
export const NEW_VIDEO_BATCH_SIZE = 10;

export function addEligibleVideo(pendingCount, eligible = true) {
  if (!eligible) return Math.max(0, Number(pendingCount || 0));
  return Math.max(0, Number(pendingCount || 0)) + 1;
}

export function shouldSendNewVideoNotification(pendingCount) {
  return Number(pendingCount || 0) >= NEW_VIDEO_BATCH_SIZE;
}

export function consumeNotificationBatch(pendingCount) {
  const count = Math.max(0, Number(pendingCount || 0));
  if (count < NEW_VIDEO_BATCH_SIZE) return { shouldSend: false, remaining: count };
  return { shouldSend: true, remaining: count - NEW_VIDEO_BATCH_SIZE };
}
