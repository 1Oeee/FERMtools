// Health check: rules for what is right and wrong in a tenant's assignments.
//
// Each check describes how things *should* look (`right`) and looks for what
// deviates. Everything is pure functions over data already fetched — no
// network, no DOM — so the rules can be tested against the demo tenant.
//
// The input:
//   groups, edges        the tree's groups and edges
//   items, assignments   items and flat assignments from assignments.js
//   composition          what each group contains directly (groups.js)
//   outside, deleted     lookups of group ids that are not in the tree
//   connections          the Connections tab's items, if fetched
//
// Member counts are floors, not exact numbers: only the first page per group
// is read. The texts say "at least" where it matters.

import { buildForest } from "../tree/build.js";
import { GUIDANCE } from "./guidance.js";
import { matchesPlatform } from "../common/platforms.js";

export const SEVERITIES = ["bad", "warn", "info"];

const DEEP = 4;
const KIOSK_MAX_DEVICES = 25;
const EXPIRY_WARN_DAYS = 30;
/** Under så här många dagar kvar — eller redan ute — är det ett fel, inte en varning. */
export const EXPIRY_CRITICAL_DAYS = 10;
const DAY = 86_400_000;

const EMPTY_DEVICES = () => ({ iOS: 0, Windows: 0, Android: 0, macOS: 0, other: 0 });
const sum = (devices) => Object.values(devices).reduce((a, b) => a + b, 0);

/**
 * Bygger uppslagen alla kontroller delar: namn, nästling och vad en gren
 * innehåller. Allt memoiseras — samma grupp frågas om många gånger.
 */
function context(input) {
  const forest = buildForest(input.groups ?? [], input.edges ?? []);
  const composition =
    input.composition instanceof Map ? input.composition : new Map(input.composition ?? []);
  const outside = new Map((input.outside ?? []).map((g) => [g.id, g.displayName]));
  const deleted = new Set(input.deleted ?? []);
  const prefix = input.prefix ?? "";
  const items = new Map((input.items ?? []).map((item) => [item.id, item]));

  const nameOf = (id) => {
    const name = forest.nodeById.get(id)?.displayName ?? outside.get(id);
    if (!name) return deleted.has(id) ? "(deleted group)" : "(unknown group)";
    return prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
  };

  const descendantsMemo = new Map();
  /** Gruppen själv och allt under den. Cirklar följs bara ett varv. */
  const descendants = (id) => {
    if (descendantsMemo.has(id)) return descendantsMemo.get(id);
    const seen = new Set([id]);
    const stack = [id];
    while (stack.length) {
      for (const child of forest.childrenOf.get(stack.pop()) ?? []) {
        if (!seen.has(child)) {
          seen.add(child);
          stack.push(child);
        }
      }
    }
    descendantsMemo.set(id, seen);
    return seen;
  };

  const subtreeMemo = new Map();
  /** Summan av vad grenen innehåller, och om vi vet det för hela grenen. */
  const subtree = (id) => {
    if (subtreeMemo.has(id)) return subtreeMemo.get(id);
    const total = { users: 0, disabled: 0, devices: EMPTY_DEVICES(), known: true, capped: false };
    for (const member of descendants(id)) {
      const c = composition.get(member);
      if (!c) {
        total.known = false;
        continue;
      }
      total.users += c.users;
      total.disabled += c.disabled ?? 0;
      for (const [os, n] of Object.entries(c.devices)) total.devices[os] += n;
      total.capped ||= Boolean(c.capped);
    }
    total.deviceCount = sum(total.devices);
    subtreeMemo.set(id, total);
    return total;
  };

  /** "users", "devices", "mixed", "empty" — eller "unknown" när underlag saknas. */
  const kindOf = (id) => {
    const s = subtree(id);
    if (!s.known) return "unknown";
    if (s.users && !s.deviceCount) return "users";
    if (s.deviceCount && !s.users) return "devices";
    if (s.users && s.deviceCount) return "mixed";
    return "empty";
  };

  const overlap = (a, b) => {
    const [small, large] = [descendants(a), descendants(b)].sort((x, y) => x.size - y.size);
    for (const id of small) if (large.has(id)) return id;
    return null;
  };

  // Tilldelningar per post, uppdelade på sort.
  const byItem = new Map();
  for (const a of input.assignments ?? []) {
    const item = items.get(a.itemId);
    if (!item) continue;
    let entry = byItem.get(item.id);
    if (!entry) {
      entry = { item, includes: [], excludes: [], allDevices: [], allUsers: [] };
      byItem.set(item.id, entry);
    }
    if (a.target === "group") entry.includes.push(a);
    else if (a.target === "exclude") entry.excludes.push(a);
    else if (a.target === "allDevices") entry.allDevices.push(a);
    else if (a.target === "allUsers") entry.allUsers.push(a);
  }

  return {
    forest,
    composition,
    haveComposition: composition.size > 0,
    haveLookup: Array.isArray(input.deleted),
    connections: input.connections ?? null,
    now: input.now ?? Date.now(),
    items,
    byItem: [...byItem.values()],
    deleted,
    nameOf,
    /** En grupp som del av en fyndtext — blir en länk i sidan. */
    group: (id) => ({ group: id, name: nameOf(id) }),
    descendants,
    subtree,
    kindOf,
    overlap
  };
}

/** En post (app eller profil) som del av en fyndtext — blir en länk i sidan. */
const app = (item) => ({ item: item.id, name: item.name });
/** En token eller ett certifikat i fyndets rad — sidan länkar den till Intune. */
const conn = (c) => ({ connection: c.id, name: c.name });

/**
 * Taggad mall för fyndens korta rad. Grupper och poster behålls som objekt,
 * så att sidan kan göra länkar av dem; allt annat blir text.
 *   say`${app(item)}: user licence to device group ${ctx.group(id)}`
 */
function say(strings, ...values) {
  const parts = [];
  const push = (part) => {
    if (part === "" || part === null || part === undefined) return;
    if (typeof part === "object") parts.push(part);
    else if (typeof parts[parts.length - 1] === "string") parts[parts.length - 1] += String(part);
    else parts.push(String(part));
  };
  strings.forEach((text, i) => {
    push(text);
    if (i < values.length) {
      const value = values[i];
      if (Array.isArray(value)) value.forEach(push);
      else push(value);
    }
  });
  return parts;
}

/** Delar med skiljetecken emellan, t.ex. flera grupper i en rad. */
const joined = (list, separator = ", ") => list.flatMap((part, i) => (i ? [separator, part] : [part]));

const plain = (parts) => parts.map((p) => (typeof p === "object" ? p.name : p)).join("");

const isVpp = (item) => item.totalLicenses !== null && item.totalLicenses !== undefined;
const osList = (devices) =>
  Object.entries(devices)
    .filter(([, n]) => n > 0)
    .map(([os]) => (os === "other" ? "other" : os))
    .join(", ");
const atLeast = (n, capped) => (capped ? `at least ${n}` : String(n));

/** Längsta vägen ner från en grupp, räknat i nivåer. Cykelsäker. */
function depthOf(ctx, id, visiting = new Set()) {
  if (visiting.has(id)) return 0;
  visiting.add(id);
  let deepest = 0;
  for (const child of ctx.forest.childrenOf.get(id) ?? []) {
    deepest = Math.max(deepest, 1 + depthOf(ctx, child, visiting));
  }
  visiting.delete(id);
  return deepest;
}

/**
 * `parts` är den korta raden, med grupper och poster som objekt så att sidan
 * kan länka dem. `text` är samma rad som ren text — för trädets detaljpanel
 * och för testerna. `detail` är den utförliga förklaringen: vad felet innebär
 * för just de här grupperna och posterna.
 *
 * @typedef {{ group: string, name: string } | { item: string, name: string }} Ref
 * @typedef {{ text: string, parts: Array<string|Ref>, detail: string, groups: string[], items: string[] }} Finding
 * @typedef {{ id: string, title: string, severity: "bad"|"warn"|"info", right: string,
 *             needs?: Array<"composition"|"lookup"|"connections">, run: (ctx: any) => Finding[] }} Check
 */

const finding = (parts, { groups = [], items = [], detail = "" } = {}) => {
  const list = typeof parts === "string" ? [parts] : parts;
  return { text: plain(list), parts: list, detail, groups, items };
};

const KIND_WORD = { users: "users", devices: "devices" };

/** @type {Check[]} */
export const CHECKS = [
  {
    id: "user-licence-to-devices",
    title: "User licence to a device group",
    severity: "bad",
    right: "User-licensed VPP apps go to groups containing users.",
    needs: ["composition"],
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes }) =>
        isVpp(item)
          ? includes
              .filter((a) => a.deviceLicensing === false && ctx.kindOf(a.groupId) === "devices")
              .map((a) =>
                finding(say`${app(item)}: user licensing to device group ${ctx.group(a.groupId)}`, {
                  groups: [a.groupId],
                  items: [item.id],
                  detail:
                    `The assignment uses user licensing, so each licence is tied to a person's Apple Account and is ` +
                    `redeemed when that account is signed in on the device. ${ctx.nameOf(a.groupId)} contains only ` +
                    "devices — typically carts, shared iPads or devices without a signed-in Apple Account — so there is " +
                    `nobody to redeem the licence. ${item.name} fails or stays pending on every device in the group, ` +
                    "and Intune keeps retrying at each sync."
                })
              )
          : []
      )
  },
  {
    id: "available-to-devices",
    title: "\"Available\" to a device group",
    severity: "bad",
    right: "Apps chosen in the Company Portal go to user groups.",
    needs: ["composition"],
    // Exceptions according to Microsoft: Win32 apps, and apps for Android Enterprise
    // fully managed and COPE devices, may be Available to device groups.
    // Which Android mode an app is used in is not visible here, so Android is skipped.
    run: (ctx) =>
      ctx.byItem
        .filter(({ item }) => item.type !== "win32LobApp" && item.platform !== "Android")
        .flatMap(({ item, includes, allDevices }) => [
          ...includes
            .filter((a) => a.intent === "available" && ctx.kindOf(a.groupId) === "devices")
            .map((a) =>
              finding(say`${app(item)}: Available to device group ${ctx.group(a.groupId)}`, {
                groups: [a.groupId],
                items: [item.id],
                detail:
                  "\"Available\" means the app is offered in the Company Portal for a signed-in user to install " +
                  `themselves. Intune evaluates Available assignments against users, and ${ctx.nameOf(a.groupId)} ` +
                  `contains only devices — so the offer reaches nobody. ${item.name} does not appear in the Company ` +
                  "Portal on those devices, and nothing is installed. (Win32 apps and Android Enterprise fully " +
                  "managed/COPE are exceptions and are not flagged.)"
              })
            ),
          ...allDevices
            .filter((a) => a.intent === "available")
            .map(() =>
              finding(say`${app(item)}: Available to All devices`, {
                items: [item.id],
                detail:
                  "\"Available\" is an offer to users in the Company Portal, and All devices is a device target. " +
                  `The combination is not evaluated for anyone, so ${item.name} is not offered anywhere.`
              })
            )
        ])
  },
  {
    id: "device-licence-to-users",
    title: "Device licence to a user group",
    // Ett tips, inte ett fel: det stöds fullt ut, och för delade konton
    // (del1 med sin vagn) är det precis rätt. Risken är bara licenser på
    // enheter man inte räknat med.
    severity: "info",
    right: "A device-licensed app to a user group lands on every device those users have — fine when that is the intent.",
    needs: ["composition"],
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes }) =>
        isVpp(item)
          ? includes
              .filter((a) => a.deviceLicensing === true && a.intent === "required" && ctx.kindOf(a.groupId) === "users")
              .map((a) =>
                finding(say`${app(item)}: device licensing to user group ${ctx.group(a.groupId)}`, {
                  groups: [a.groupId],
                  items: [item.id],
                  detail:
                    "This is supported, and often right. Device licensing ties each licence to a device, and the " +
                    `assignment is Required to ${ctx.nameOf(a.groupId)}, a user group — so Intune installs ${item.name} ` +
                    "on every device those users are enrolled with, one licence per device. For a shared account " +
                    "with its cart, or 1:1 iPads with user affinity, that is exactly the point. Worth a look only if " +
                    "the group also holds people with devices that shouldn't get the app: a user with an iPad and an " +
                    "iPhone takes two licences, and personal or never-retired devices take one each."
                })
              )
          : []
      )
  },
  {
    id: "licence-overcommit",
    title: "More recipients than licences",
    severity: "bad",
    right: "Every VPP app has enough licences for its required recipients.",
    needs: ["composition"],
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes }) => {
        if (!isVpp(item)) return [];
        const required = includes.filter((a) => a.intent === "required");
        if (!required.length) return [];

        // The same group can be reached from several assignments — count it once.
        const userGroups = new Set();
        const deviceGroups = new Set();
        for (const a of required) {
          const into = a.deviceLicensing ? deviceGroups : userGroups;
          for (const id of ctx.descendants(a.groupId)) into.add(id);
        }

        let need = 0;
        let capped = false;
        for (const id of userGroups) {
          const c = ctx.composition.get(id);
          if (c) {
            need += c.users;
            capped ||= c.capped;
          }
        }
        for (const id of deviceGroups) {
          const c = ctx.composition.get(id);
          if (c) {
            need += c.devices.iOS + c.devices.macOS;
            capped ||= c.capped;
          }
        }

        if (need <= item.totalLicenses) return [];
        const targets = [...new Set(required.map((a) => a.groupId))];
        const used = typeof item.usedLicenses === "number" ? ` (${item.usedLicenses} in use)` : "";
        return [
          finding(say`${app(item)}: ${atLeast(need, capped)} required recipients, ${item.totalLicenses} licences`, {
            groups: required.map((a) => a.groupId),
            items: [item.id],
            detail:
              `Required assignments via ${targets.map(ctx.nameOf).join(", ")} reach ${atLeast(need, capped)} ` +
              "recipients — users for user licensing, iOS and macOS devices for device licensing, each group counted " +
              `once even when it is reached through nesting. Only ${item.totalLicenses} licences exist${used}. ` +
              "Licences are handed out first come, first served: the recipients left over get an install error " +
              "(no licences available) and retry at every sync until licences are freed or bought." +
              (capped ? " Member counts are floors — the real shortfall may be larger." : "")
          })
        ];
      })
  },
  {
    id: "licences-exhausted",
    title: "Out of licences",
    severity: "info",
    right: "All VPP apps have free licences.",
    run: (ctx) =>
      ctx.byItem
        .filter(({ item }) => isVpp(item) && item.totalLicenses > 0 && item.usedLicenses >= item.totalLicenses)
        .map(({ item }) =>
          finding(say`${app(item)}: all ${item.totalLicenses} licences used`, {
            items: [item.id],
            detail:
              `Every purchased licence for ${item.name} is assigned. Nothing is broken yet, but the margin is gone: ` +
              "the next user or device that should get the app — a new student, a replaced iPad — fails with a " +
              "licence error until a licence is freed or bought."
          })
        )
  },
  {
    id: "platform-mismatch",
    title: "Wrong platform",
    severity: "bad",
    right: "Apps and profiles go to devices on the right platform.",
    needs: ["composition"],
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes }) => {
        if (!item.platform) return [];
        return includes
          .filter((a) => {
            if (ctx.kindOf(a.groupId) !== "devices") return false;
            const s = ctx.subtree(a.groupId);
            // iPadOS and macOS sometimes share apps; do not count them as wrong for each other.
            const fits = s.devices[item.platform] + (item.platform === "iOS" ? s.devices.macOS : 0);
            return fits === 0;
          })
          .map((a) => {
            const os = osList(ctx.subtree(a.groupId).devices);
            return finding(say`${app(item)} (${item.platform}) to ${ctx.group(a.groupId)} (${os})`, {
              groups: [a.groupId],
              items: [item.id],
              detail:
                `${item.name} only applies to ${item.platform}, but every device in ${ctx.nameOf(a.groupId)} ` +
                `and its subgroups is ${os}. Intune reports the assignment as "Not applicable" and nothing happens. ` +
                "It is often a sign that the wrong group was picked — and that the group which should have had it " +
                "is missing it."
            });
          });
      })
  },
  {
    id: "mixed-exclusion",
    title: "Exclusion of the wrong kind",
    severity: "bad",
    right: "Exclusions are of the same kind as the assignment — users against users, devices against devices.",
    needs: ["composition"],
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes, excludes, allDevices, allUsers }) => {
        const includeKinds = new Set(includes.map((a) => ctx.kindOf(a.groupId)));
        if (allDevices.length) includeKinds.add("devices");
        if (allUsers.length) includeKinds.add("users");

        return excludes
          .filter((a) => {
            const kind = ctx.kindOf(a.groupId);
            return (
              (kind === "users" && includeKinds.has("devices") && !includeKinds.has("users")) ||
              (kind === "devices" && includeKinds.has("users") && !includeKinds.has("devices"))
            );
          })
          .map((a) => {
            const kind = ctx.kindOf(a.groupId);
            const other = kind === "users" ? "devices" : "users";
            return finding(
              say`${app(item)}: ${kind === "users" ? "user" : "device"} group ${ctx.group(a.groupId)} excluded from a ${other === "users" ? "user" : "device"} assignment`,
              {
                groups: [a.groupId],
                items: [item.id],
                detail:
                  "Intune only honours exclusions of the same kind as the assignment: user groups exclude from user " +
                  `assignments, device groups from device assignments. ${item.name} is assigned to ${KIND_WORD[other]}, ` +
                  `but the excluded group ${ctx.nameOf(a.groupId)} contains ${KIND_WORD[kind]}. The exclusion is ` +
                  "ignored, so whoever it was meant to keep out still gets it."
              }
            );
          });
      })
  },
  {
    id: "exclusion-inside-target",
    title: "Exclusion inside an assigned group",
    severity: "info",
    right: "No exclusions that need double-checking.",
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes, excludes }) =>
        excludes.flatMap((ex) => {
          const parent = includes.find((a) => a.groupId !== ex.groupId && ctx.descendants(a.groupId).has(ex.groupId));
          return parent
            ? [
                finding(say`${app(item)}: ${ctx.group(ex.groupId)} excluded inside ${ctx.group(parent.groupId)}`, {
                  groups: [parent.groupId, ex.groupId],
                  items: [item.id],
                  detail:
                    `${ctx.nameOf(parent.groupId)} gets ${item.name}, but ${ctx.nameOf(ex.groupId)} — nested inside ` +
                    "it — is excluded. Exclusions win, so its members do not get it. That may well be intended, as " +
                    "an exception, but it cannot be seen from the groups themselves and is easy to forget when the " +
                    "structure changes."
                })
              ]
            : [];
        })
      )
  },
  {
    id: "intent-conflict",
    title: "Install and uninstall at the same time",
    severity: "bad",
    right: "No app is installed and uninstalled on the same recipient.",
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes }) => {
        const install = includes.filter((a) => a.intent === "required" || a.intent === "available");
        const remove = includes.filter((a) => a.intent === "uninstall");
        const found = [];
        for (const a of install) {
          for (const b of remove) {
            const shared = ctx.overlap(a.groupId, b.groupId);
            if (!shared) continue;
            found.push(
              finding(say`${app(item)}: install via ${ctx.group(a.groupId)}, uninstall via ${ctx.group(b.groupId)}`, {
                groups: [a.groupId, b.groupId],
                items: [item.id],
                detail:
                  `Members of ${ctx.nameOf(shared)} are reached both by ${a.intent === "required" ? "Required" : "Available"} ` +
                  `(via ${ctx.nameOf(a.groupId)}) and by Uninstall (via ${ctx.nameOf(b.groupId)}). Intune settles the ` +
                  "conflict with its own table — Required beats Uninstall, Uninstall beats Available — so the result " +
                  "follows the intents, not what was meant, and can differ between user and device targeting."
              })
            );
          }
        }
        return found;
      })
  },
  {
    id: "empty-target",
    title: "Assigned to an empty group",
    severity: "warn",
    right: "All assigned groups have members.",
    needs: ["composition"],
    run: (ctx) => {
      const byGroup = new Map();
      for (const { item, includes } of ctx.byItem) {
        for (const a of includes) {
          if (ctx.kindOf(a.groupId) !== "empty") continue;
          const list = byGroup.get(a.groupId) ?? [];
          if (!list.includes(item)) list.push(item);
          byGroup.set(a.groupId, list);
        }
      }
      return [...byGroup].map(([id, items]) => {
        const rule = ctx.forest.nodeById.get(id)?.membershipRule;
        return finding(say`${ctx.group(id)}: empty, ${items.length} assignment(s)`, {
          groups: [id],
          items: items.map((i) => i.id),
          detail:
            `No users or devices were found in ${ctx.nameOf(id)} or its subgroups, yet ${items.map((i) => i.name).join(", ")} ` +
            "is assigned to it. Nothing is delivered. " +
            (rule
              ? `The group is dynamic with the rule ${rule} — no object matches it. Compare the rule with the ` +
                "attribute values it looks for; a typo or a renamed enrolment profile is enough to empty the group."
              : "If the group is meant to be filled later this is harmless; otherwise the intended recipients are " +
                "in another group.")
        });
      });
    }
  },
  {
    id: "deleted-target",
    title: "Assignment to a deleted group",
    severity: "bad",
    right: "No assignments point to groups that have been deleted.",
    needs: ["lookup"],
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes, excludes }) =>
        [...includes, ...excludes]
          .filter((a) => ctx.deleted.has(a.groupId))
          .map((a) =>
            finding(say`${app(item)}: ${a.target === "exclude" ? "excludes" : "assigned to"} a deleted group`, {
              groups: [a.groupId],
              items: [item.id],
              detail:
                `The assignment points to group ID ${a.groupId}, which no longer exists in Entra. The portal does not ` +
                "list it among the item's groups, so it is hard to see or remove there, and " +
                (a.target === "exclude"
                  ? "the exclusion keeps nobody out any more."
                  : "nobody receives what the assignment was meant to give.") +
                " A group deleted within the last 30 days can be restored under Groups → Deleted groups — the audit " +
                "log below shows who deleted it."
            })
          )
      )
  },
  {
    id: "disabled-users",
    title: "Licences held by disabled accounts",
    severity: "warn",
    right: "No VPP licences go to groups where the accounts are disabled.",
    needs: ["composition"],
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes }) =>
        isVpp(item)
          ? includes
              .filter((a) => {
                const s = ctx.subtree(a.groupId);
                return a.deviceLicensing === false && s.users > 0 && s.disabled / s.users >= 0.5;
              })
              .map((a) => {
                const s = ctx.subtree(a.groupId);
                return finding(say`${app(item)}: ${s.disabled} of ${s.users} accounts disabled in ${ctx.group(a.groupId)}`, {
                  groups: [a.groupId],
                  items: [item.id],
                  detail:
                    `${s.disabled} of ${s.users} user accounts in ${ctx.nameOf(a.groupId)} are disabled. User ` +
                    "licences stay assigned to those accounts until the app is set to Uninstall for them or the " +
                    "licences are revoked — they are locked up and cannot be used by anyone else."
                });
              })
          : []
      )
  },
  {
    id: "duplicate-ssid",
    title: "Several Wi-Fi profiles for the same network",
    severity: "warn",
    right: "Each Wi-Fi network has one profile per platform.",
    run: (ctx) => {
      const bySsid = new Map();
      for (const entry of ctx.byItem) {
        if (!entry.item.ssid) continue;
        const key = `${entry.item.platform}|${entry.item.ssid}`;
        bySsid.set(key, [...(bySsid.get(key) ?? []), entry]);
      }

      const found = [];
      for (const list of bySsid.values()) {
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const [a, b] = [list[i], list[j]];
            let shared = null;
            for (const x of a.includes) {
              for (const y of b.includes) shared ??= ctx.overlap(x.groupId, y.groupId);
            }
            if (!shared) continue;
            found.push(
              finding(say`${app(a.item)} and ${app(b.item)}: same network "${a.item.ssid}" in ${ctx.group(shared)}`, {
                groups: [shared],
                items: [a.item.id, b.item.id],
                detail:
                  `Both profiles configure the network ${a.item.ssid}${a.item.platform ? ` on ${a.item.platform}` : ""} ` +
                  `and both reach the devices in ${ctx.nameOf(shared)}. A device keeps whichever profile it applied ` +
                  "last, so settings such as security type, certificate and proxy can differ from device to device " +
                  "and change after a sync."
              })
            );
          }
        }
      }
      return found;
    }
  },
  {
    id: "mixed-group",
    title: "Profile to a group with both users and devices",
    severity: "warn",
    right: "Profiles go to groups with either users or devices.",
    needs: ["composition"],
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes }) =>
        item.kind === "config"
          ? includes
              .filter((a) => {
                const c = ctx.composition.get(a.groupId);
                return c && c.users > 0 && sum(c.devices) > 0;
              })
              .map((a) =>
                finding(say`${app(item)}: to mixed group ${ctx.group(a.groupId)}`, {
                  groups: [a.groupId],
                  items: [item.id],
                  detail:
                    `${ctx.nameOf(a.groupId)} has both users and devices as direct members. A profile assigned to a ` +
                    "user applies to every device that user is enrolled with, so it also lands on the users' other " +
                    "devices — not only on the devices listed in the group."
                })
              )
          : []
      )
  },
  {
    id: "redundant-assignment",
    title: "Double assignment through nesting",
    severity: "info",
    right: "No item is assigned to both a group and a group inside it.",
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes }) => {
        const found = [];
        for (const outer of includes) {
          for (const inner of includes) {
            if (outer === inner || outer.groupId === inner.groupId || outer.intent !== inner.intent) continue;
            if (!ctx.descendants(outer.groupId).has(inner.groupId)) continue;
            found.push(
              finding(say`${app(item)}: ${ctx.group(inner.groupId)} already inside ${ctx.group(outer.groupId)}`, {
                groups: [outer.groupId, inner.groupId],
                items: [item.id],
                detail:
                  `${ctx.nameOf(inner.groupId)} is nested in ${ctx.nameOf(outer.groupId)}, and both have the same ` +
                  "assignment. The inner one adds nothing today; it only matters if the group is moved out of the " +
                  "outer one. That is why it is worth a look rather than an error."
              })
            );
          }
        }
        return found;
      })
  },
  {
    id: "cycle",
    title: "Circular membership",
    severity: "warn",
    right: "No groups contain themselves via other groups.",
    run: (ctx) => {
      const inCycle = (id) => (ctx.forest.childrenOf.get(id) ?? []).some((c) => ctx.descendants(c).has(id));
      const seen = new Set();
      const found = [];

      for (const id of ctx.forest.nodeById.keys()) {
        if (seen.has(id) || !inCycle(id)) continue;
        const ring = [...ctx.descendants(id)].filter((n) => ctx.descendants(n).has(id));
        ring.forEach((n) => seen.add(n));

        const affected = ctx.byItem.filter(({ includes }) => includes.some((a) => ring.includes(a.groupId)));

        found.push(
          finding(say`${joined(ring.map(ctx.group), " ↔ ")}: circular membership`, {
            groups: ring,
            items: affected.map(({ item }) => item.id),
            detail:
              `${ring.map(ctx.nameOf).join(", ")} contain each other through nesting. Entra allows it, but anything ` +
              "that walks the membership — Intune's evaluation, reports, this tree — has to cut the loop somewhere, " +
              "so who is actually a member is ambiguous." +
              (affected.length
                ? ` Assigned there: ${affected.map(({ item }) => item.name).join(", ")} — it is unclear who gets it.`
                : "")
          })
        );
      }
      return found;
    }
  },
  {
    id: "deep-nesting",
    title: "Deep nesting",
    severity: "info",
    right: `Assigned groups are at most ${DEEP - 1} levels deep, so the reach can be surveyed.`,
    run: (ctx) => {
      const byGroup = new Map();
      for (const { item, includes } of ctx.byItem) {
        for (const a of includes) {
          if (depthOf(ctx, a.groupId) < DEEP) continue;
          const list = byGroup.get(a.groupId) ?? [];
          if (!list.includes(item)) list.push(item);
          byGroup.set(a.groupId, list);
        }
      }
      return [...byGroup].map(([id, items]) => {
        const depth = depthOf(ctx, id);
        const below = ctx.descendants(id).size - 1;
        return finding(say`${ctx.group(id)}: ${depth} levels, ${below} groups below`, {
          groups: [id],
          items: items.map((i) => i.id),
          detail:
            `Everything assigned to ${ctx.nameOf(id)} reaches ${below} groups up to ${depth} levels down: ` +
            `${items.map((i) => i.name).join(", ")}. The deeper the nesting, the harder it is to tell from a single ` +
            "group what it receives, and a membership change far down silently widens or narrows the reach."
        });
      });
    }
  },
  {
    id: "duplicate-item",
    title: "The same app or profile several times",
    severity: "warn",
    right: "Each app and profile exists once.",
    run: (ctx) => {
      const byName = new Map();
      for (const item of ctx.items.values()) {
        const key = `${item.type}|${item.name}`;
        byName.set(key, [...(byName.get(key) ?? []), item]);
      }
      return [...byName.values()]
        .filter((list) => list.length > 1)
        .map((list) => {
          const orgs = [...new Set(list.map((i) => i.vppOrganization).filter(Boolean))];
          return finding(say`${app(list[0])}: exists ${list.length} times`, {
            items: list.map((i) => i.id),
            detail:
              `There are ${list.length} items named ${list[0].name}` +
              (orgs.length > 1 ? `, from different VPP tokens (${orgs.join(" and ")})` : "") +
              ". Assignments can be split between them, reports count them separately, and for VPP apps each copy " +
              "has its own licence count — one copy can look out of licences while another has plenty."
          });
        });
    }
  },
  {
    id: "restriction-all-users",
    title: "Restrictions to all users",
    severity: "warn",
    right: "Restriction profiles go to defined groups, not to all users.",
    run: (ctx) =>
      ctx.byItem
        .filter(({ item, allUsers }) => allUsers.length && /GeneralDeviceConfiguration$|GeneralConfiguration$|Restriction/i.test(item.type ?? ""))
        .map(({ item }) =>
          finding(say`${app(item)}: restrictions to All users`, {
            items: [item.id],
            detail:
              `${item.name} is assigned to All users, so it applies to the devices of every licensed user — staff ` +
              "and administrators too, not only students. Restrictions such as blocked app installs, camera or " +
              "account changes then hit devices they were never meant for."
          })
        )
  },
  {
    id: "kiosk-large",
    title: "Kiosk mode on a large group",
    severity: "bad",
    right: `Kiosk profiles only go to small device groups (at most ${KIOSK_MAX_DEVICES} devices).`,
    needs: ["composition"],
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes }) =>
        /kiosk/i.test(item.type ?? "")
          ? includes
              .filter((a) => ctx.subtree(a.groupId).deviceCount > KIOSK_MAX_DEVICES)
              .map((a) => {
                const s = ctx.subtree(a.groupId);
                return finding(say`${app(item)}: kiosk to ${ctx.group(a.groupId)} (${atLeast(s.deviceCount, s.capped)} devices)`, {
                  groups: [a.groupId],
                  items: [item.id],
                  detail:
                    "A kiosk profile locks a device to one or a few apps. Through " +
                    `${ctx.nameOf(a.groupId)} it reaches ${atLeast(s.deviceCount, s.capped)} devices, and all of ` +
                    "them are put in kiosk mode at their next sync. Removing the assignment afterwards does not " +
                    "always reset the device."
                });
              })
          : []
      )
  },
  {
    id: "users-in-device-branch",
    title: "User group among device groups",
    severity: "warn",
    right: "User groups are not nested among device groups.",
    needs: ["composition"],
    run: (ctx) => {
      const found = [];
      for (const [id, childIds] of ctx.forest.childrenOf) {
        const kinds = childIds.map((c) => [c, ctx.kindOf(c)]);
        const deviceChildren = kinds.filter(([, k]) => k === "devices").length;
        const userChildren = kinds.filter(([, k]) => k === "users").map(([c]) => c);
        if (deviceChildren < 2 || !userChildren.length || userChildren.length >= deviceChildren) continue;
        for (const child of userChildren) {
          found.push(
            finding(say`User group ${ctx.group(child)} inside device branch ${ctx.group(id)}`, {
              groups: [id, child],
              detail:
                `The other subgroups of ${ctx.nameOf(id)} contain devices, but ${ctx.nameOf(child)} contains users. ` +
                `Device profiles assigned to ${ctx.nameOf(id)} now also target these users, and through them every ` +
                "device they are enrolled with."
            })
          );
        }
      }
      return found;
    }
  },
  {
    id: "overlapping-rings",
    title: "Overlapping update rings",
    severity: "bad",
    right: "Each device is in a single update ring.",
    run: (ctx) => {
      const rings = ctx.byItem.filter(({ item }) => /UpdateForBusiness|updateRing/i.test(item.type ?? ""));
      const found = [];
      for (let i = 0; i < rings.length; i++) {
        for (let j = i + 1; j < rings.length; j++) {
          let shared = null;
          for (const x of rings[i].includes) {
            for (const y of rings[j].includes) shared ??= ctx.overlap(x.groupId, y.groupId);
          }
          if (!shared) continue;
          found.push(
            finding(say`${app(rings[i].item)} and ${app(rings[j].item)} overlap in ${ctx.group(shared)}`, {
              groups: [shared],
              items: [rings[i].item.id, rings[j].item.id],
              detail:
                `Both update rings reach the devices in ${ctx.nameOf(shared)}. A device should be in exactly one ` +
                "ring; with two, the settings conflict, Intune reports a conflict for the device, and deferrals and " +
                "deadlines become unpredictable."
            })
          );
        }
      }
      return found;
    }
  },
  {
    id: "compliance-per-platform",
    title: "Platform without a compliance policy",
    severity: "bad",
    right: "Every platform with devices has an assigned compliance policy.",
    needs: ["composition"],
    run: (ctx) => {
      const devices = EMPTY_DEVICES();
      for (const c of ctx.composition.values()) {
        for (const [os, n] of Object.entries(c.devices)) devices[os] += n;
      }
      const covered = new Set(
        ctx.byItem
          .filter(({ item, includes, allDevices, allUsers }) =>
            item.sourceKey === "compliance" && (includes.length || allDevices.length || allUsers.length))
          .map(({ item }) => item.platform)
      );
      return Object.entries(devices)
        .filter(([os, n]) => os !== "other" && n > 0 && !covered.has(os))
        .map(([os, n]) =>
          finding(say`${os}: at least ${n} devices, no compliance policy`, {
            detail:
              `No compliance policy for ${os} is assigned, so at least ${n} ${os} devices are never checked. With ` +
              "the tenant default \"Mark devices with no compliance policy assigned as: Compliant\" they count as " +
              "compliant anyway — and pass any Conditional Access rule that requires a compliant device."
          })
        );
    }
  },
  {
    id: "licences-without-assignment",
    title: "Used licences without an assignment",
    severity: "warn",
    right: "No VPP licences are used by apps that are no longer assigned.",
    run: (ctx) => {
      const assigned = new Set(ctx.byItem.map(({ item }) => item.id));
      return [...ctx.items.values()]
        .filter((item) => isVpp(item) && item.usedLicenses > 0 && !assigned.has(item.id))
        .map((item) =>
          finding(say`${app(item)}: ${item.usedLicenses} licences used, no assignment`, {
            items: [item.id],
            detail:
              `${item.name} has no assignments, but ${item.usedLicenses} licences are still in use. Removing an ` +
              "assignment does not revoke licences, so they stay with the users or devices that got them and " +
              "cannot be reused."
          })
        );
    }
  },
  {
    id: "uninstall-to-everyone",
    title: "Uninstall to everyone",
    severity: "bad",
    right: "No app is uninstalled from all users or all devices.",
    run: (ctx) =>
      ctx.byItem
        .filter(({ allDevices, allUsers }) => [...allDevices, ...allUsers].some((a) => a.intent === "uninstall"))
        .map(({ item }) =>
          finding(say`${app(item)}: uninstall to everyone`, {
            items: [item.id],
            detail:
              `${item.name} is assigned as Uninstall to All users or All devices. It is removed everywhere, and any ` +
              "group that should have it as Required now conflicts with the uninstall — the outcome follows " +
              "Intune's conflict rules, not the intention."
          })
        )
  },
  {
    id: "include-and-exclude-same",
    title: "The same group assigned and excluded",
    severity: "warn",
    right: "No group is both assigned and excluded for the same item.",
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes, excludes }) =>
        excludes
          .filter((ex) => includes.some((a) => a.groupId === ex.groupId))
          .map((ex) =>
            finding(say`${app(item)}: ${ctx.group(ex.groupId)} both included and excluded`, {
              groups: [ex.groupId],
              items: [item.id],
              detail:
                `${ctx.nameOf(ex.groupId)} is both assigned and excluded. Exclusions always win in Intune, so ` +
                `nobody in the group gets ${item.name} — the assignment has no effect.`
            })
          )
      )
  },
  {
    id: "expired-connections",
    title: `Connections that have expired or expire within ${EXPIRY_CRITICAL_DAYS} days`,
    severity: "bad",
    right: `No token or certificate has expired or expires within ${EXPIRY_CRITICAL_DAYS} days.`,
    needs: ["connections"],
    run: (ctx) => expiring(ctx, (days) => days < EXPIRY_CRITICAL_DAYS)
  },
  {
    id: "expiring-connections",
    title: "Connections that are expiring",
    severity: "warn",
    right: `No tokens or certificates expire within ${EXPIRY_WARN_DAYS} days.`,
    needs: ["connections"],
    run: (ctx) => expiring(ctx, (days) => days >= EXPIRY_CRITICAL_DAYS && days <= EXPIRY_WARN_DAYS)
  }
];

/**
 * Anslutningar vars återstående dagar `within` släpper igenom, som fynd.
 * Delas av felet (under tio dagar) och varningen (inom en månad).
 */
function expiring(ctx, within) {
  return (ctx.connections?.items ?? [])
    .filter((c) => c.expires)
    .map((c) => ({ c, days: Math.floor((new Date(c.expires).getTime() - ctx.now) / DAY) }))
    .filter(({ days }) => within(days))
    .map(({ c, days }) =>
      finding(
        days < 0
          ? say`${c.sourceLabel}: ${conn(c)} expired ${-days} days ago`
          : say`${c.sourceLabel}: ${conn(c)} expires in ${days} days`,
        {
          detail:
            `${c.name} ${days < 0 ? "expired" : "expires"} on ${new Date(c.expires).toISOString().slice(0, 10)}. ` +
            "When a connection expires, whatever depends on it stops: without APNS, Apple devices stop receiving " +
            "anything from Intune; without a valid VPP token, app licences stop syncing; without an Android " +
            "enrolment token, new devices cannot enrol."
        }
      )
    );
}

const RANK = { bad: 0, warn: 1, info: 2 };

/** Den allvarligaste av två nivåer. */
export const worse = (a, b) => (!a ? b : !b ? a : RANK[a] <= RANK[b] ? a : b);

/**
 * Fynden per grupp, för trädet. `direct` är fynd som pekar på gruppen själv;
 * `below` säger att något är fel längre ner i grenen, så att det syns även
 * när grenen är ihopfälld. Bara fel och varningar sprids uppåt — tips om
 * nästling och dubbletter skulle färga halva trädet.
 *
 * Varje fynd får en `ref`, `kontroll#index`, som Hälsokontroll-fliken hittar
 * det med.
 *
 * @param {ReturnType<typeof analyse>} analysis
 * @param {Map<string, string[]>} parentsOf
 */
export function findingsByGroup(analysis, parentsOf) {
  const direct = new Map();

  for (const check of analysis?.checks ?? []) {
    if (check.status !== "found") continue;
    check.findings.forEach((finding, index) => {
      for (const groupId of new Set(finding.groups)) {
        const list = direct.get(groupId) ?? [];
        list.push({
          ref: `${check.id}#${index}`,
          checkId: check.id,
          index,
          severity: check.severity,
          title: check.title,
          text: finding.text,
          parts: finding.parts
        });
        direct.set(groupId, list);
      }
    });
  }

  for (const list of direct.values()) list.sort((a, b) => RANK[a.severity] - RANK[b.severity]);

  const below = new Map();
  for (const [groupId, list] of direct) {
    const serious = list.filter((f) => f.severity !== "info");
    if (!serious.length) continue;

    const seen = new Set();
    const stack = [...(parentsOf.get(groupId) ?? [])];
    while (stack.length) {
      const parent = stack.pop();
      if (seen.has(parent)) continue;
      seen.add(parent);
      const entry = below.get(parent) ?? { severity: null, count: 0 };
      entry.severity = worse(entry.severity, serious[0].severity);
      entry.count += serious.length;
      below.set(parent, entry);
      stack.push(...(parentsOf.get(parent) ?? []));
    }
  }

  return { direct, below };
}

/**
 * Kör alla kontroller.
 * @returns {{ checks: Array<{id, title, severity, right, status: "ok"|"found"|"unknown", findings: Finding[]}>,
 *            counts: { bad: number, warn: number, info: number, ok: number, unknown: number } }}
 */
export function analyse(input) {
  const ctx = context(input);
  const available = {
    composition: ctx.haveComposition,
    lookup: ctx.haveLookup,
    connections: Boolean(ctx.connections)
  };

  const checks = CHECKS.map((check) => {
    const guidance = GUIDANCE[check.id] ?? { fix: [], docs: [] };
    const base = {
      id: check.id,
      title: check.title,
      severity: check.severity,
      right: check.right,
      fix: guidance.fix,
      docs: guidance.docs
    };
    if ((check.needs ?? []).some((need) => !available[need])) {
      return { ...base, status: "unknown", findings: [] };
    }
    const findings = check.run(ctx);
    return { ...base, status: findings.length ? "found" : "ok", findings };
  });

  const counts = { bad: 0, warn: 0, info: 0, ok: 0, unknown: 0 };
  for (const check of checks) {
    if (check.status === "found") counts[check.severity] += 1;
    else counts[check.status] += 1;
  }

  return { checks, counts };
}

/**
 * Samma analys, avgränsad till en plattform. Ett fynd står kvar om någon av
 * dess poster gäller plattformen, eller om det inte handlar om någon post
 * alls (t.ex. gruppstruktur). Poster utan känd plattform gäller alla.
 *
 * @param {ReturnType<typeof analyse>} analysis
 * @param {Array<{id: string, platform: string|null}>} items
 * @param {string} platform tomt = ingen avgränsning
 */
export function forPlatform(analysis, items, platform) {
  if (!platform || !analysis) return analysis;
  const platformOf = new Map(items.map((item) => [item.id, item.platform ?? null]));
  const keep = (finding) =>
    !finding.items?.length || finding.items.some((id) => matchesPlatform(platformOf.get(id) ?? null, platform));

  const checks = analysis.checks.map((check) => {
    if (check.status !== "found") return check;
    const findings = check.findings.filter(keep);
    return { ...check, status: findings.length ? "found" : "ok", findings };
  });

  const counts = { bad: 0, warn: 0, info: 0, ok: 0, unknown: 0 };
  for (const check of checks) {
    if (check.status === "found") counts[check.severity] += 1;
    else counts[check.status] += 1;
  }
  return { checks, counts };
}
