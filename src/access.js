// Kivora owner billing bypass. This is a convenience entitlement, not a substitute
// for Firebase Auth verification on the server.
export const KIVORA_OWNER_EMAIL = "ilemobayotolulope11092003@gmail.com";

export function isKivoraOwner(user) {
  return String(user?.email || "").trim().toLowerCase() === KIVORA_OWNER_EMAIL;
}
