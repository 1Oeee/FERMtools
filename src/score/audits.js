// Tenant score: how the tenant is set up, measured against what Microsoft
// recommends — graded the way Lighthouse grades a web page.
//
// This is not the health check. The health check looks for mistakes in
// assignments and groups. The score looks at the tenant's configuration and
// its fleet: are the compliance settings strict, are the endpoint security
// policies Microsoft recommends in place, are devices encrypted, compliant and
// checking in. Each audit cites the Microsoft Learn page it is based on.
//
// Scoring, as in Lighthouse:
//   - Every audit scores 0–1. Most are pass/fail; the fleet metrics score on a
//     curve between a "poor" and a "good" share.
//   - Audits have weights. A category is the weighted mean of its audits, 0–100.
//   - Weight 0 means informative: shown, never scored.
//   - An audit whose data could not be read is left out, not counted as a
//     pass. One that does not apply (no Windows devices, say) is left out too.
//   - The tenant score is the mean of the categories that have a score.
//   - Bands: 0–49 poor, 50–89 needs work, 90–100 good.
//
// Pure functions over already-fetched data. No network, no DOM.

const LEARN = "https://learn.microsoft.com/en-us";

// Checked against Learn's canonical addresses, September 2026.
export const DOCS = {
  compliance: { label: "Device compliance policies", url: `${LEARN}/intune/device-security/compliance/overview` },
  complianceMonitor: { label: "Monitor compliance", url: `${LEARN}/intune/device-security/compliance/monitor-policy` },
  endpointSecurity: { label: "Endpoint security in Intune", url: `${LEARN}/intune/device-security/endpoint-security-policies` },
  diskEncryption: { label: "Disk encryption policy", url: `${LEARN}/intune/device-configuration/endpoint-security/disk-encryption` },
  antivirus: { label: "Antivirus policy", url: `${LEARN}/intune/device-configuration/endpoint-security/antivirus` },
  firewall: { label: "Firewall policy", url: `${LEARN}/intune/device-configuration/endpoint-security/firewall` },
  asr: { label: "Attack surface reduction", url: `${LEARN}/intune/device-configuration/endpoint-security/attack-surface-reduction` },
  laps: { label: "Windows LAPS with Intune", url: `${LEARN}/intune/device-security/laps/overview` },
  baselines: { label: "Security baselines", url: `${LEARN}/intune/device-security/security-baselines/overview` },
  rings: { label: "Update rings for Windows", url: `${LEARN}/intune/device-updates/windows/manage-update-rings` },
  hello: { label: "Tenant-wide Windows Hello for Business", url: `${LEARN}/intune/device-security/identity-protection/configure-tenant-wide-policy` },
  restrictions: { label: "Device platform restrictions", url: `${LEARN}/intune/device-enrollment/create-platform-restrictions` },
  cleanup: { label: "Device cleanup rules", url: `${LEARN}/intune/governance/configure-cleanup-rules` }
};

const DAY = 86_400_000;
const STALE_DAYS = 30;

// --- Uppslag som granskningarna delar -------------------------------------

/** "Windows", "macOS", "iOS", "Android" eller "other" ur Intunes operatingSystem. */
function osOf(value) {
  const os = String(value ?? "");
  if (/^windows/i.test(os)) return "Windows";
  if (/^mac/i.test(os)) return "macOS";
  if (/^i(os|pados)/i.test(os)) return "iOS";
  if (/^android/i.test(os)) return "Android";
  return "other";
}

// Äldre endpoint security-policyer (intents) säger vad de är genom sin mall.
const SUBTYPE_FAMILY = {
  antivirus: "antivirus",
  diskEncryption: "diskEncryption",
  firewall: "firewall",
  attackSurfaceReduction: "asr",
  accountProtection: "accountProtection",
  endpointDetectionReponse: "edr"
};

// Settings catalog säger det i templateReference.templateFamily.
const TEMPLATE_FAMILY = {
  endpointSecurityAntivirus: "antivirus",
  endpointSecurityDiskEncryption: "diskEncryption",
  endpointSecurityFirewall: "firewall",
  endpointSecurityAttackSurfaceReduction: "asr",
  endpointSecurityAccountProtection: "accountProtection",
  endpointSecurityEndpointDetectionAndResponse: "edr",
  baseline: "baseline"
};

function context(input) {
  const assignedIds = new Set(
    (input.assignments ?? []).filter((a) => a.target !== "exclude").map((a) => a.itemId)
  );

  /** family → namnen på tilldelade policyer av den sorten. */
  const families = new Map();
  const add = (family, name) => {
    if (!family) return;
    const list = families.get(family) ?? [];
    list.push(name);
    families.set(family, list);
  };

  for (const item of input.items ?? []) {
    if (!assignedIds.has(item.id)) continue;
    add(TEMPLATE_FAMILY[item.templateFamily], item.name);
    if (item.type === "windows10EndpointProtectionConfiguration" && item.bitLocker) add("diskEncryption", item.name);
    if (item.type === "macOSEndpointProtectionConfiguration" && item.fileVault) add("diskEncryption", item.name);
    if (item.type === "windowsUpdateForBusinessConfiguration") add("updateRing", item.name);
  }

  const templates = new Map((input.templates ?? []).map((t) => [t.id, t]));
  for (const intent of input.intents ?? []) {
    if (!intent.isAssigned) continue;
    const template = templates.get(intent.templateId);
    if (!template) continue;
    if (/baseline/i.test(template.templateType ?? "")) add("baseline", intent.displayName);
    else add(SUBTYPE_FAMILY[template.templateSubtype], intent.displayName);
  }

  const devices = input.devices ?? null;
  const osCount = new Map();
  for (const d of devices ?? []) osCount.set(osOf(d.os), (osCount.get(osOf(d.os)) ?? 0) + 1);

  return {
    families,
    devices,
    osCount,
    settings: input.settings ?? null,
    enrollment: input.enrollment ?? null,
    cleanup: input.cleanup ?? null,
    now: input.now ?? Date.now(),
    // Klassiska endpoint security-policyer är frivilliga att läsa. Fanns de
    // inte att läsa kan en äldre policy saknas i familjerna — det sägs i texten.
    intentsRead: Array.isArray(input.intents) && Array.isArray(input.templates)
  };
}

// --- Byggstenar -----------------------------------------------------------

const pct = (n) => `${Math.round(n * 100)}%`;

/** Linjär kurva: `poor` eller sämre ger 0, `good` eller bättre ger 1. */
const curve = (value, poor, good) => Math.max(0, Math.min(1, (value - poor) / (good - poor)));

/** Finns en tilldelad policy av sorten? */
function policyAudit(family, noun) {
  return (ctx) => {
    const found = ctx.families.get(family) ?? [];
    if (found.length) {
      return { score: 1, detail: `Assigned: ${found.slice(0, 3).join(", ")}${found.length > 3 ? ` and ${found.length - 3} more` : ""}.` };
    }
    return {
      score: 0,
      detail:
        `No assigned ${noun} was found.` +
        (ctx.intentsRead ? "" : " Older endpoint security policies could not be read, so one may exist there.")
    };
  };
}

/** Andelen enheter som uppfyller något, bland dem det gäller. */
function shareAudit({ filter = () => true, test, known = () => true, poor, good, what }) {
  return (ctx) => {
    const pool = ctx.devices.filter(filter).filter(known);
    if (!pool.length) return null; // gäller inga enheter
    const hits = pool.filter(test).length;
    const share = hits / pool.length;
    return {
      score: curve(share, poor, good),
      detail: `${pct(share)} of ${pool.length} devices ${what} (${pool.length - hits} not). Good is ${pct(good)} or more.`
    };
  };
}

const hasWindows = (ctx) => !ctx.devices || (ctx.osCount.get("Windows") ?? 0) > 0;
const hasWindowsOrMac = (ctx) =>
  !ctx.devices || (ctx.osCount.get("Windows") ?? 0) + (ctx.osCount.get("macOS") ?? 0) > 0;

// --- Granskningarna -------------------------------------------------------

/**
 * @typedef {{ id: string, category: string, title: string, weight: number, right: string,
 *   docs: Array<{label: string, url: string}>, needs?: string[], applies?: (ctx) => boolean,
 *   run: (ctx) => ({score: number, detail: string}|null) }} Audit
 * @type {Audit[]}
 */
export const AUDITS = [
  // Compliance
  {
    id: "no-policy-not-compliant",
    category: "compliance",
    title: "Devices without a compliance policy count as not compliant",
    weight: 10,
    right: "\"Mark devices with no compliance policy assigned as\" is set to Not compliant, so Conditional Access only trusts devices that have actually been checked.",
    docs: [DOCS.compliance],
    needs: ["settings"],
    run: (ctx) =>
      ctx.settings.secureByDefault
        ? { score: 1, detail: "Set to Not compliant." }
        : { score: 0, detail: "Set to Compliant (the default): a device nothing has checked counts as compliant." }
  },
  {
    id: "compliance-validity",
    category: "compliance",
    title: "Compliance status expires within 30 days",
    weight: 3,
    right: "The compliance status validity period is 30 days or less, so a device that stops checking in stops counting as compliant.",
    docs: [DOCS.compliance],
    needs: ["settings"],
    run: (ctx) => {
      const days = Number(ctx.settings.validityDays);
      if (!Number.isFinite(days)) return null;
      return days <= 30
        ? { score: 1, detail: `${days} days.` }
        : { score: 0, detail: `${days} days: a silent device keeps its compliant status for too long.` };
    }
  },
  {
    id: "compliance-rate",
    category: "compliance",
    title: "Devices are compliant",
    weight: 10,
    right: "Nearly every managed device reports compliant. Non-compliant devices are fixed or retired, not left standing.",
    docs: [DOCS.complianceMonitor],
    needs: ["devices"],
    run: shareAudit({
      known: (d) => d.compliance && d.compliance !== "unknown",
      test: (d) => d.compliance === "compliant" || d.compliance === "inGracePeriod",
      poor: 0.7,
      good: 0.95,
      what: "are compliant"
    })
  },

  // Device security
  {
    id: "disk-encryption",
    category: "security",
    title: "Disk encryption policy",
    weight: 10,
    right: "BitLocker (Windows) and FileVault (macOS) are required by an assigned endpoint security disk encryption policy.",
    docs: [DOCS.diskEncryption],
    applies: hasWindowsOrMac,
    run: policyAudit("diskEncryption", "disk encryption policy")
  },
  {
    id: "encryption-rate",
    category: "security",
    title: "Computers are encrypted",
    weight: 10,
    right: "Every Windows and macOS device reports its disk as encrypted.",
    docs: [DOCS.diskEncryption],
    needs: ["devices"],
    run: shareAudit({
      filter: (d) => ["Windows", "macOS"].includes(osOf(d.os)),
      known: (d) => d.encrypted !== null,
      test: (d) => d.encrypted,
      poor: 0.6,
      good: 0.95,
      what: "(Windows and macOS) are encrypted"
    })
  },
  {
    id: "antivirus",
    category: "security",
    title: "Antivirus policy",
    weight: 10,
    right: "Microsoft Defender Antivirus is managed by an assigned endpoint security antivirus policy.",
    docs: [DOCS.antivirus],
    applies: hasWindowsOrMac,
    run: policyAudit("antivirus", "antivirus policy")
  },
  {
    id: "firewall",
    category: "security",
    title: "Firewall policy",
    weight: 3,
    right: "The built-in firewall is turned on and managed by an assigned endpoint security firewall policy.",
    docs: [DOCS.firewall],
    applies: hasWindowsOrMac,
    run: policyAudit("firewall", "firewall policy")
  },
  {
    id: "asr",
    category: "security",
    title: "Attack surface reduction rules",
    weight: 3,
    right: "Attack surface reduction rules are deployed with an assigned endpoint security ASR policy.",
    docs: [DOCS.asr],
    applies: hasWindows,
    run: policyAudit("asr", "attack surface reduction policy")
  },
  {
    id: "laps",
    category: "security",
    title: "Local admin passwords are managed (LAPS)",
    weight: 3,
    right: "Windows LAPS rotates and backs up the local administrator password through an account protection policy.",
    docs: [DOCS.laps],
    applies: hasWindows,
    run: policyAudit("accountProtection", "account protection (LAPS) policy")
  },
  {
    id: "security-baseline",
    category: "security",
    title: "Security baseline",
    weight: 3,
    right: "A Microsoft security baseline is assigned, giving Windows devices Microsoft's recommended security defaults.",
    docs: [DOCS.baselines],
    applies: hasWindows,
    run: policyAudit("baseline", "security baseline")
  },

  // Updates & sign-in
  {
    id: "update-rings",
    category: "updates",
    title: "Windows update rings",
    weight: 10,
    right: "Windows devices get quality and feature updates through an assigned update ring.",
    docs: [DOCS.rings],
    applies: hasWindows,
    run: (ctx) => {
      const found = ctx.families.get("updateRing") ?? [];
      return found.length
        ? { score: 1, detail: `${found.length} assigned ring(s): ${found.slice(0, 3).join(", ")}${found.length > 3 ? " …" : ""}.` }
        : { score: 0, detail: "No assigned Windows update ring was found." };
    }
  },
  {
    id: "windows-hello",
    category: "updates",
    title: "Windows Hello for Business at enrollment",
    weight: 3,
    right: "The tenant-wide Windows Hello for Business policy is enabled, so users sign in with a PIN or biometrics instead of a password.",
    docs: [DOCS.hello],
    needs: ["enrollment"],
    applies: hasWindows,
    run: (ctx) => {
      const hello = ctx.enrollment.find((c) => /WindowsHelloForBusiness/i.test(c.type));
      if (!hello) return null;
      return hello.state === "enabled"
        ? { score: 1, detail: "Enabled." }
        : { score: 0, detail: `The tenant-wide policy is ${hello.state === "disabled" ? "disabled" : "not configured"}.` };
    }
  },
  {
    id: "personal-windows",
    category: "updates",
    title: "Personally owned Windows enrollment",
    weight: 0,
    right: "Consider blocking personally owned Windows devices, so only Autopilot and other corporate enrollments are accepted.",
    docs: [DOCS.restrictions],
    needs: ["enrollment"],
    applies: hasWindows,
    run: (ctx) => {
      const defaults = ctx.enrollment.filter((c) => /PlatformRestrictions/i.test(c.type) && c.windowsPersonalBlocked !== null);
      if (!defaults.length) return null;
      return defaults.some((c) => c.windowsPersonalBlocked)
        ? { score: 1, detail: "Personally owned Windows devices are blocked." }
        : { score: 0, detail: "Personally owned Windows devices may enroll." };
    }
  },

  // Device hygiene
  {
    id: "cleanup-rules",
    category: "hygiene",
    title: "Device cleanup rules",
    weight: 3,
    right: "Cleanup rules hide devices that haven't checked in for a set number of days, so reports and counts reflect the real fleet.",
    docs: [DOCS.cleanup],
    needs: ["cleanup"],
    run: (ctx) =>
      ctx.cleanup.days > 0
        ? { score: 1, detail: `Devices are cleaned up after ${ctx.cleanup.days} days without check-in.` }
        : { score: 0, detail: "No cleanup rule is configured." }
  },
  {
    id: "stale-devices",
    category: "hygiene",
    title: `Devices check in at least every ${STALE_DAYS} days`,
    weight: 10,
    right: `Nearly every device has synced with Intune in the last ${STALE_DAYS} days. Silent devices get no policies or updates.`,
    docs: [DOCS.cleanup, DOCS.complianceMonitor],
    needs: ["devices"],
    run: (ctx) =>
      shareAudit({
        known: (d) => Boolean(d.lastSync),
        test: (d) => ctx.now - Date.parse(d.lastSync) <= STALE_DAYS * DAY,
        poor: 0.7,
        good: 0.95,
        what: `checked in within ${STALE_DAYS} days`
      })(ctx)
  }
];

export const CATEGORIES = [
  {
    id: "compliance",
    title: "Compliance",
    description: "Devices are only trusted after Intune has checked them, and most of them pass."
  },
  {
    id: "security",
    title: "Device security",
    description: "Microsoft's endpoint security policies are in place, and computers are encrypted."
  },
  {
    id: "updates",
    title: "Updates & sign-in",
    description: "Windows is kept up to date, and users sign in without passwords."
  },
  {
    id: "hygiene",
    title: "Device hygiene",
    description: "The inventory reflects the real fleet: devices check in, and old records are cleaned up."
  }
];

/** @returns {"good"|"average"|"poor"|"none"} */
export function rating(score) {
  if (score === null || score === undefined) return "none";
  if (score >= 90) return "good";
  if (score >= 50) return "average";
  return "poor";
}

/** Lighthouse räknar en granskning som godkänd från 0,9. */
const PASS = 0.9;

/**
 * @param {{ items?, assignments?, settings?, enrollment?, devices?, cleanup?, intents?, templates?, now? }} input
 *   Varje del är null/utelämnad när den inte kunde läsas.
 */
export function scoreTenant(input) {
  const ctx = context(input);
  const available = {
    settings: Boolean(ctx.settings),
    enrollment: Array.isArray(ctx.enrollment),
    devices: Array.isArray(ctx.devices),
    cleanup: Boolean(ctx.cleanup)
  };

  const audits = AUDITS.map((audit) => {
    const base = {
      id: audit.id,
      category: audit.category,
      title: audit.title,
      weight: audit.weight,
      right: audit.right,
      docs: audit.docs
    };
    const missing = (audit.needs ?? []).filter((need) => !available[need]);
    if (missing.length) return { ...base, status: "unknown", missing };
    if (audit.applies && !audit.applies(ctx)) return { ...base, status: "na" };

    const result = audit.run(ctx);
    if (!result) return { ...base, status: "na" };

    const status = audit.weight === 0 ? (result.score >= PASS ? "pass" : "info") : result.score >= PASS ? "pass" : "fail";
    return { ...base, status, score: result.score, detail: result.detail };
  });

  const categories = CATEGORIES.map((category) => {
    const own = audits.filter((a) => a.category === category.id);
    const scored = own.filter((a) => a.weight > 0 && (a.status === "pass" || a.status === "fail"));
    const total = scored.reduce((sum, a) => sum + a.weight, 0);
    const earned = scored.reduce((sum, a) => sum + a.weight * a.score, 0);
    const score = total ? Math.round((100 * earned) / total) : null;

    return {
      ...category,
      score,
      rating: rating(score),
      failed: own
        .filter((a) => a.status === "fail")
        .map((a) => ({ ...a, cost: Math.round((100 * a.weight * (1 - a.score)) / total) }))
        .sort((a, b) => b.cost - a.cost),
      diagnostics: own.filter((a) => a.status === "info"),
      passed: own.filter((a) => a.status === "pass"),
      notApplicable: own.filter((a) => a.status === "na"),
      unknown: own.filter((a) => a.status === "unknown")
    };
  });

  const rated = categories.filter((c) => c.score !== null);
  const overall = rated.length ? Math.round(rated.reduce((sum, c) => sum + c.score, 0) / rated.length) : null;
  return { overall, rating: rating(overall), categories, audits };
}
