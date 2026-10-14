// Server-side Kivora owner billing bypass.
// Always compare the authenticated Firebase identity email server-side; never trust
// an email supplied in the request body.
export const KIVORA_OWNER_EMAIL = "ilemobayotolulope11092003@gmail.com";

export function isKivoraOwnerEmail(email) {
  return String(email || "").trim().toLowerCase() === KIVORA_OWNER_EMAIL;
}

export function ownerBillingOverride(userOrEmail) {
  const email = typeof userOrEmail === "string" ? userOrEmail : userOrEmail?.email;
  return isKivoraOwnerEmail(email);
}
