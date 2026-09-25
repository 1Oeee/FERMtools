// Fixes for the health check rules — one per check, not per finding.
//
// DRAFT: written from Microsoft's documentation (linked under each entry) and
// general Intune practice, not from your organisation's procedures. Go through
// them and adjust before relying on them. Everything about a check's fix lives
// here, so it can be reviewed in one place.
//
// `fix` is a list. Where there is more than one right answer — it depends on
// what was intended — the alternatives follow one another, and the later ones
// start with "Or:". `docs` points to Microsoft Learn; the addresses were checked
// against Learn's canonical URLs (September 2026).

const LEARN = "https://learn.microsoft.com/en-us";

export const DOCS = {
  vpp: { label: "Manage Apple volume-purchased apps", url: `${LEARN}/intune/app-management/deployment/manage-vpp-apple` },
  assignApps: { label: "Assign apps to groups", url: `${LEARN}/intune/app-management/deployment/assign-groups` },
  appScope: { label: "Include and exclude app assignments", url: `${LEARN}/intune/app-management/deployment/configure-assignment-scope` },
  assignProfiles: { label: "Assign device profiles", url: `${LEARN}/intune/device-configuration/assign-device-profile` },
  dynamic: { label: "Dynamic group membership rules", url: `${LEARN}/entra/identity/users/groups-dynamic-membership` },
  wifi: { label: "Wi-Fi profiles", url: `${LEARN}/intune/device-configuration/templates/configure-wifi` },
  rings: { label: "Update rings for Windows", url: `${LEARN}/intune/device-updates/windows/manage-update-rings` },
  kiosk: { label: "Kiosk settings for Windows", url: `${LEARN}/intune/device-configuration/templates/configure-kiosk` },
  compliance: { label: "Compliance policies", url: `${LEARN}/intune/device-security/compliance/overview` },
  apns: { label: "Apple MDM Push certificate", url: `${LEARN}/intune/device-enrollment/apple/create-mdm-push-certificate` },
  filters: { label: "Assignment filters", url: `${LEARN}/intune/fundamentals/filters/overview` }
};

/** @type {Record<string, { fix: string[], docs: Array<{label: string, url: string}> }>} */
export const GUIDANCE = {
  "user-licence-to-devices": {
    fix: [
      "Change the licence type to device licence in the assignment. Devices without a signed-in user, such as carts and shared iPads, can only use device licences.",
      "Or: assign the app to the users who should have it instead of to the device group.",
      "Do not give the same app both a user licence and a device licence on the same device — it is not supported and causes install errors."
    ],
    docs: [DOCS.vpp]
  },
  "available-to-devices": {
    fix: [
      "Assign the app as Available to a user group instead — then it shows in the Company Portal.",
      "Or: make it Required for the device group if it should be on all devices there."
    ],
    docs: [DOCS.assignApps]
  },
  "device-licence-to-users": {
    fix: [
      "Nothing to do if the group holds shared accounts or 1:1 users whose every device should have the app.",
      "If licences land on devices that shouldn't have the app (personal phones, old devices): assign to the device group instead.",
      "Or: switch to a user licence if the app should follow the person. That requires each user to have their own Apple account."
    ],
    docs: [DOCS.vpp]
  },
  "licence-overcommit": {
    fix: [
      "Buy more licences in Apple School or Business Manager and sync the token in Intune.",
      "Or: narrow the assignment to the groups that actually need the app.",
      "Or: make it Available to user groups instead of Required — then a licence is only used when someone installs it."
    ],
    docs: [DOCS.vpp]
  },
  "licences-exhausted": {
    fix: [
      "Check whether licences are held by users or devices that no longer need the app. Set the assignment to Uninstall for them, or revoke the licences — simply removing the assignment does not free them.",
      "If the need is real: buy more licences."
    ],
    docs: [DOCS.vpp]
  },
  "platform-mismatch": {
    fix: [
      "Remove the assignment — it does nothing on that platform.",
      "Check whether another group was intended. Group names are often close to each other, and whatever should have gone there is then missing."
    ],
    docs: [DOCS.assignProfiles]
  },
  "mixed-exclusion": {
    fix: [
      "Exclude a group of the same kind as the assignment: users from user assignments, devices from device assignments.",
      "Or: use an assignment filter to narrow which devices are targeted."
    ],
    docs: [DOCS.assignProfiles, DOCS.filters]
  },
  "exclusion-inside-target": {
    fix: [
      "If the exclusion is no longer needed: remove it.",
      "If it is intentional: write why in the group's description, so the next person knows."
    ],
    docs: [DOCS.appScope]
  },
  "intent-conflict": {
    fix: [
      "Remove the overlap, so the same devices or users are not in both the group that installs and the group that uninstalls.",
      "According to Microsoft's conflict table, Required wins over Uninstall — so the uninstall does not happen. If some should not have the app: exclude them from the install instead."
    ],
    docs: [DOCS.assignApps]
  },
  "empty-target": {
    fix: [
      "Compare the membership rule with the value it is looking for. A typo, or an enrolment profile that was renamed, is enough to leave the group empty.",
      "If the group is empty on purpose: remove the assignment, or the group."
    ],
    docs: [DOCS.dynamic]
  },
  "deleted-target": {
    fix: [
      "Remove the assignment and add the group that should have the item instead.",
      "If the group is only soft-deleted in Entra it can be restored — then the assignment applies again."
    ],
    docs: [DOCS.assignApps]
  },
  "disabled-users": {
    fix: [
      "Set the assignment to Uninstall for the group. Simply removing the assignment does not reclaim the licences.",
      "Then clean the group of accounts that should not remain."
    ],
    docs: [DOCS.vpp]
  },
  "duplicate-ssid": {
    fix: [
      "Keep one profile per network and platform, and remove the assignment on the old one.",
      "If both must stay during a transition: make sure their groups do not overlap."
    ],
    docs: [DOCS.wifi]
  },
  "mixed-group": {
    fix: [
      "Split the group into a user group and a device group, and assign the profile to the device group.",
      "Or: assign to the users and use a filter that only targets the right devices."
    ],
    docs: [DOCS.assignProfiles, DOCS.filters]
  },
  "redundant-assignment": {
    fix: [
      "Remove the assignment to the inner group — the outer one already covers it.",
      "If the inner one is there on purpose, for example to survive changes to the outer one: write that in the description."
    ],
    docs: [DOCS.assignApps]
  },
  cycle: {
    fix: ["Remove one direction of the membership, so the groups no longer contain each other."],
    docs: [DOCS.assignApps]
  },
  "deep-nesting": {
    fix: [
      "Assign to the groups that should actually have the item, instead of via a group several levels up.",
      "Or: flatten the structure, so it is visible on the group what it reaches."
    ],
    docs: [DOCS.assignApps]
  },
  "duplicate-item": {
    fix: [
      "Keep one of the items and remove the assignments on the other.",
      "If the duplicate comes from an old or expired VPP token: move the licences to the current location in Apple School or Business Manager, sync, and revoke the licences on the old token before it is removed."
    ],
    docs: [DOCS.vpp]
  },
  "restriction-all-users": {
    fix: [
      "Assign the profile to the student groups, or to the students' device groups, instead of to all users.",
      "Or: keep All users but add a filter that only targets the students' devices."
    ],
    docs: [DOCS.assignProfiles, DOCS.filters]
  },
  "kiosk-large": {
    fix: [
      "Move the assignment to the kiosk computers' own group immediately — the profile locks every device it reaches.",
      "Then check that the devices actually leave kiosk mode. A removed profile does not always reset the setting on the device."
    ],
    docs: [DOCS.kiosk, DOCS.assignProfiles]
  },
  "users-in-device-branch": {
    fix: [
      "Take the user group out of the device branch.",
      "If the users should have the same apps: assign them directly to the user group instead."
    ],
    docs: [DOCS.assignProfiles]
  },
  "overlapping-rings": {
    fix: [
      "Keep each device in a single ring: exclude the pilot ring's device group from the broader ring.",
      "Exclude device groups from device assignments — a user group as an exclusion does not apply."
    ],
    docs: [DOCS.rings, DOCS.assignProfiles]
  },
  "compliance-per-platform": {
    fix: [
      "Create a compliance policy for the platform and assign it.",
      "Also review the setting \"Mark devices with no compliance policy assigned as\". The default is Compliant."
    ],
    docs: [DOCS.compliance]
  },
  "licences-without-assignment": {
    fix: [
      "Revoke the licences under the app's App licences, or assign the app as Uninstall to those who have it. Removing the assignment does not free any licences."
    ],
    docs: [DOCS.vpp]
  },
  "uninstall-to-everyone": {
    fix: ["Replace the All assignment with an uninstall for the groups that should actually lose the app."],
    docs: [DOCS.assignApps]
  },
  "include-and-exclude-same": {
    fix: ["Remove either the assignment or the exclusion. Exclusions win, so as it stands nobody in the group gets the item."],
    docs: [DOCS.appScope]
  },
  "expired-connections": {
    fix: [
      "Renew it today — see the steps below. An expired APNS certificate cuts every Apple device off from Intune; an expired VPP token stops licences syncing; an expired enrolment token stops new devices.",
      "APNS certificate: renew it with the same Apple ID that created it — a new Apple ID means re-enrolling every Apple device.",
      "VPP token: download a new token from Apple School or Business Manager and upload it to the existing token in Intune.",
      "Android enrolment: replace the token in the enrolment profile."
    ],
    docs: [DOCS.apns, DOCS.vpp]
  },
  "expiring-connections": {
    fix: [
      "APNS certificate: renew it with the same Apple ID that created it. If it expires, Apple devices stop receiving anything from Intune.",
      "VPP token: download a new token from Apple School or Business Manager and upload it to the existing token in Intune.",
      "Android enrolment: replace the token in the enrolment profile before it expires."
    ],
    docs: [DOCS.apns, DOCS.vpp]
  }
};
