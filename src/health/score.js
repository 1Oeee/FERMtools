// Tenant score: the health check's rules, graded the way Lighthouse grades a
// web page.
//
// Lighthouse turns a list of audits into a 0–100 score per category, weighted
// by how much each audit matters. Here the audits are the health check's rules
// (src/health/checks.js), which describe how Microsoft's Intune documentation
// says a tenant should look, and the categories group them by what they protect.
// The score is computed from the same analysis the Health check tab shows, so
// the two can never disagree.
//
// Rules:
//   - An audit passes when its check found nothing, and fails otherwise.
//   - Errors weigh 10, warnings 3. Tips ("worth a look") are diagnostics: shown,
//     never scored — like Lighthouse's informative audits.
//   - An audit that could not be run is left out of the sum, not counted as a
//     pass. A category where nothing could be run has no score.
//   - The tenant score is the mean of the categories that have one.
//   - Bands follow Lighthouse: 0–49 poor, 50–89 needs work, 90–100 good.
//
// Pure functions, no DOM — tested against the demo tenant.

export const WEIGHTS = { bad: 10, warn: 3, info: 0 };

export const CATEGORIES = [
  {
    id: "security",
    title: "Security & compliance",
    description: "Every device is checked for compliance, and update and enrollment rules don't fight each other.",
    checks: ["compliance-per-platform", "overlapping-rings", "restriction-all-users"]
  },
  {
    id: "targeting",
    title: "Targeting",
    description: "Apps and profiles reach the right kind of recipient: devices, users and platforms as Microsoft intends.",
    checks: [
      "user-licence-to-devices",
      "available-to-devices",
      "device-licence-to-users",
      "platform-mismatch",
      "mixed-exclusion",
      "mixed-group",
      "include-and-exclude-same",
      "kiosk-large",
      "exclusion-inside-target"
    ]
  },
  {
    id: "conflicts",
    title: "Conflicts & duplicates",
    description: "Nothing is installed and removed at once, and the same thing isn't delivered twice.",
    checks: ["intent-conflict", "uninstall-to-everyone", "duplicate-item", "duplicate-ssid", "redundant-assignment"]
  },
  {
    id: "structure",
    title: "Group structure",
    description: "Assignments point at live groups, and the nesting stays shallow and free of loops.",
    checks: ["empty-target", "deleted-target", "cycle", "users-in-device-branch", "deep-nesting"]
  },
  {
    id: "lifecycle",
    title: "Licences & connections",
    description: "VPP licences add up and are not held by departed users, and tokens are renewed in time.",
    checks: [
      "licence-overcommit",
      "licences-without-assignment",
      "disabled-users",
      "expiring-connections",
      "licences-exhausted"
    ]
  }
];

/** @returns {"good"|"average"|"poor"|"none"} */
export function rating(score) {
  if (score === null || score === undefined) return "none";
  if (score >= 90) return "good";
  if (score >= 50) return "average";
  return "poor";
}

const ORDER = { bad: 0, warn: 1, info: 2 };

/**
 * @param {{checks: Array<{id: string, severity: "bad"|"warn"|"info", status: "ok"|"found"|"unknown", findings: any[]}>}} analysis
 */
export function scoreTenant(analysis) {
  const byId = new Map((analysis?.checks ?? []).map((check) => [check.id, check]));

  const categories = CATEGORIES.map((category) => {
    const checks = category.checks.map((id) => byId.get(id)).filter(Boolean);
    const scored = checks.filter((c) => WEIGHTS[c.severity] > 0 && c.status !== "unknown");

    const total = scored.reduce((sum, c) => sum + WEIGHTS[c.severity], 0);
    const earned = scored.filter((c) => c.status === "ok").reduce((sum, c) => sum + WEIGHTS[c.severity], 0);
    const score = total ? Math.round((100 * earned) / total) : null;

    const failed = checks
      .filter((c) => c.status === "found" && WEIGHTS[c.severity] > 0)
      .map((c) => ({ ...c, weight: WEIGHTS[c.severity], cost: total ? Math.round((100 * WEIGHTS[c.severity]) / total) : 0 }))
      .sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || b.findings.length - a.findings.length);

    return {
      id: category.id,
      title: category.title,
      description: category.description,
      score,
      rating: rating(score),
      failed,
      diagnostics: checks.filter((c) => c.status === "found" && WEIGHTS[c.severity] === 0),
      passed: checks.filter((c) => c.status === "ok"),
      unknown: checks.filter((c) => c.status === "unknown")
    };
  });

  const rated = categories.filter((c) => c.score !== null);
  const overall = rated.length ? Math.round(rated.reduce((sum, c) => sum + c.score, 0) / rated.length) : null;

  return { overall, rating: rating(overall), categories };
}
