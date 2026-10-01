// Status för tokens och certifikat, och vad man gör när den inte är bra.
//
// Graph har inget statusfält för ADE-tokens (depOnboardingSetting) — portalen
// räknar fram det ur utgångsdatum och `lastSyncErrorCode`. Texterna ska vara
// exakt de som bladet Enrollment program tokens (DepTokensPaging.ReactView)
// visar. Orsaker och åtgärder bygger på Microsofts felsökningsartikel för
// ADE-synkfel (länkad nedan).
//
// Felkod → portaltext är inte dokumenterat, så bara koder som stämts av mot
// portalen står i SYNC_ERRORS. Okända koder visas som "Sync error" med koden,
// hellre än med en gissad text. Bekräftat (oktober 2026): 3.

const LEARN = "https://learn.microsoft.com/en-us";

const DOCS = {
  syncErrors: {
    label: "Sync token errors between Intune and ADE",
    url: `${LEARN}/troubleshoot/mem/intune/device-enrollment/troubleshoot-ios-enrollment-errors#sync-token-errors-between-intune-and-ade`
  },
  renewAde: {
    label: "Renew an enrollment program token",
    url: `${LEARN}/intune/device-enrollment/apple/manage-devices-tokens-macos`
  },
  vpp: {
    label: "Manage Apple volume-purchased apps",
    url: `${LEARN}/intune/app-management/deployment/manage-vpp-apple`
  }
};

/**
 * Apples två portaler. ADE-tokens säger vilken i `tokenType` (portalens
 * "Program Type"), VPP-tokens i `vppTokenAccountType`.
 */
export const PROGRAMS = {
  abm: { name: "Apple Business Manager", short: "ABM", url: "https://business.apple.com/" },
  asm: { name: "Apple School Manager", short: "ASM", url: "https://school.apple.com/" }
};

/** Vilken av Apples portaler tokenen hör till, eller null om okänt. */
export function programOf(item) {
  switch (item.tokenType ?? item.vppTokenAccountType) {
    case "dep":
    case "business":
      return "abm";
    case "appleSchoolManager":
    case "education":
      return "asm";
    default:
      return null;
  }
}

/** `lastSyncErrorCode` → status. Bara koder som stämts av mot portalen. */
const SYNC_ERRORS = {
  3: "termsNotAccepted"
};

/**
 * `tone` styr färgen (samma klasser som utgångsdatumen), `icon` symbolen
 * framför texten — portalen visar ✓ för Active och ✕ för fel.
 *
 * @type {Record<string, {label: string, tone: string, icon: string, cause?: string, fix?: string[], docs?: Array<{label: string, url: string}>}>}
 */
export const STATUSES = {
  active: { label: "Active", tone: "ok", icon: "ok" },
  valid: { label: "Active", tone: "ok", icon: "ok" },
  termsNotAccepted: {
    label: "Terms & Conditions not accepted",
    tone: "critical",
    icon: "bad",
    cause:
      "Apple has published new terms and conditions in Apple Business Manager / Apple School Manager, and nobody has accepted them yet. Until someone does, Apple refuses to sync — new devices do not reach Intune and enrollment profiles are not assigned.",
    fix: [
      "Sign in to Apple Business Manager (business.apple.com) or Apple School Manager (school.apple.com) with an account that has the Administrator role.",
      "Accept the terms when they are shown. Other roles do not get the prompt.",
      "In Intune, open the token and choose Sync now — the status turns Active after the next successful sync."
    ],
    docs: [DOCS.syncErrors]
  },
  // Utgånget betyder olika saker för olika sorter — se BY_SOURCE nedan.
  expired: {
    label: "Expired",
    tone: "critical",
    icon: "bad",
    cause: "The expiry date has passed. Whatever depends on it has stopped working until it is renewed.",
    fix: ["Renew it in Intune with a new file from Apple or Google."],
    docs: []
  },
  syncError: {
    label: "Sync error",
    tone: "critical",
    icon: "bad",
    cause:
      "Apple refused the last sync. Inu+ does not yet know the portal's text for this error code — the token's page in Intune shows it. The usual causes: the token was revoked or replaced, Intune was removed as MDM server, or new terms are waiting to be accepted.",
    fix: [
      "Open the token in Intune (click its name) to see the exact error.",
      "In Apple Business/School Manager: accept any new terms, and check that Intune is still listed as MDM server.",
      "If the token was revoked or replaced, renew it in Intune with a freshly downloaded token, then choose Sync now."
    ],
    docs: [DOCS.syncErrors]
  },
  invalid: {
    label: "Invalid",
    tone: "critical",
    icon: "bad",
    cause: "Apple no longer accepts the token. It has been revoked, replaced by a newer download, or is malformed.",
    fix: ["Download a new token for the same location in Apple Business/School Manager and upload it to the existing token in Intune."],
    docs: [DOCS.vpp]
  },
  assignedToExternalMDM: {
    label: "Assigned to external MDM",
    tone: "critical",
    icon: "bad",
    cause: "The VPP token is in use by another MDM solution. Apple lets only one MDM manage a location's licences.",
    fix: ["Remove the token from the other MDM, or choose to take over the token when you upload it to Intune again."],
    docs: [DOCS.vpp]
  },
  duplicateLocationId: {
    label: "Duplicate location",
    tone: "warn",
    icon: "warn",
    cause: "Another VPP token in the tenant points to the same location in Apple Business/School Manager.",
    fix: ["Keep one token per location and delete the duplicate in Intune."],
    docs: [DOCS.vpp]
  }
};

/**
 * Samma status kan behöva olika åtgärd beroende på källan — ett utgånget
 * APNS-certifikat förnyas inte som en ADE-token. Nyckel: `status:sourceKey`.
 */
const BY_SOURCE = {
  "expired:appleEnrollment": {
    cause:
      "The token's expiry date has passed, so Intune can no longer sync with Apple. New devices do not reach Intune and enrollment profiles are not assigned.",
    fix: [
      "In Apple Business/School Manager, download a new server token for the same MDM server.",
      "In Intune, open the token, choose Renew token and upload the file. Renew — do not create a new token, or the device assignments are lost."
    ],
    docs: [DOCS.renewAde, DOCS.syncErrors]
  },
  "expired:vppTokens": {
    cause:
      "The VPP token has expired. Licences no longer sync, and apps bought through Apple Business/School Manager cannot be assigned or installed on new devices.",
    fix: [
      "In Apple Business/School Manager, go to Preferences > Payments and Billing and download a new content token for the same location.",
      "In Intune, open the token, choose Edit and upload the new file. Upload it to the existing token — a new token means new licence assignments."
    ],
    docs: [DOCS.vpp]
  },
  "expired:androidEnrollment": {
    cause: "The enrollment token in the profile has expired. Devices can no longer enroll with this profile's QR code or token.",
    fix: [
      "In Intune, open the enrollment profile and choose Token > Revoke token, then Replace token, and set a new expiry date (at most 65 years).",
      "Print or distribute the new QR code — the old one no longer works."
    ],
    docs: []
  },
  "expired:apns": {
    cause: "The Apple MDM push certificate has expired. Apple devices no longer receive anything from Intune, and no new Apple devices can enroll.",
    fix: [
      "Renew the certificate at identity.apple.com/pushcert with the same Apple ID that created it, then upload it in Intune.",
      "Do not create a new certificate with another Apple ID — that means re-enrolling every Apple device."
    ],
    docs: [{ label: "Apple MDM Push certificate", url: `${LEARN}/intune/device-enrollment/apple/create-mdm-push-certificate` }]
  }
};

// Texterna nämner "Apple Business/School Manager" och liknande. När tokenens
// program är känt byts det mot rätt portal, så att man vet vart man ska.
const MANAGER_TEXT =
  /Apple Business Manager \(business\.apple\.com\) or Apple School Manager \(school\.apple\.com\)|Apple Business Manager \/ Apple School Manager|Apple Business\/School Manager|Business or School Manager/g;

/**
 * Orsak, åtgärd och länkar för en post — källans egna om de finns, och med
 * rätt Apple-portal när programmet är känt. `program` är då med, för knappen
 * som tar en dit.
 */
export function guidanceFor(item) {
  const base = STATUSES[item.status];
  if (!base?.cause) return null;
  const merged = { ...base, ...(BY_SOURCE[`${item.status}:${item.sourceKey}`] ?? {}) };
  const program = PROGRAMS[item.program] ?? null;
  if (!program) return { ...merged, program: null };

  const name = (text) => text.replace(MANAGER_TEXT, program.name);
  return {
    ...merged,
    cause: name(merged.cause),
    fix: (merged.fix ?? []).map(name),
    program
  };
}

/**
 * Status som portalen visar den. VPP har ett eget `state` (valid, expired,
 * invalid …), som används när det finns.
 */
export function statusOf(item, expires, now = Date.now()) {
  if (expires && Date.parse(expires) < now) return "expired";
  const code = item.lastSyncErrorCode;
  if (typeof code === "number" && code !== 0) return SYNC_ERRORS[code] ?? "syncError";
  if (item.state) return item.state;
  return expires ? "active" : null;
}

/** Etikett, ton och symbol för en status, även för värden vi inte känner. */
export function describeStatus(status) {
  return STATUSES[status] ?? { label: status ?? "Unknown", tone: "unknown", icon: null };
}

/** Finns det något att förklara? Bara statusar med en orsak är klickbara. */
export const hasGuidance = (status) => Boolean(STATUSES[status]?.cause);
