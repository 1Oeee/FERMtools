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

export const SEVERITIES = ["bad", "warn", "info"];

const DEEP = 4;
const KIOSK_MAX_DEVICES = 25;
const EXPIRY_WARN_DAYS = 30;
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
    descendants,
    subtree,
    kindOf,
    overlap
  };
}

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
 * @typedef {{ text: string, groups: string[], items: string[] }} Finding
 * @typedef {{ id: string, title: string, severity: "bad"|"warn"|"info", right: string,
 *             needs?: Array<"composition"|"lookup"|"connections">, run: (ctx: any) => Finding[] }} Check
 */

const finding = (text, { groups = [], items = [] } = {}) => ({ text, groups, items });

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
                finding(
                  `${item.name} has a user licence but goes to ${ctx.nameOf(a.groupId)}, which contains only devices. ` +
                    "Without a signed-in user the licence can never be redeemed.",
                  { groups: [a.groupId], items: [item.id] }
                )
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
            finding(
              `${item.name} is available to ${ctx.nameOf(a.groupId)}, which contains only devices. ` +
                "Available only works against users — the app is not visible anywhere.",
              { groups: [a.groupId], items: [item.id] }
            )
          ),
        ...allDevices
          .filter((a) => a.intent === "available")
          .map((a) => finding(`${item.name} is available to all devices — it is not visible anywhere.`, { items: [item.id] }))
      ])
  },
  {
    id: "device-licence-to-users",
    title: "Device licence to a user group",
    severity: "warn",
    right: "Device-licensed VPP apps go to device groups.",
    needs: ["composition"],
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes }) =>
        isVpp(item)
          ? includes
              .filter((a) => a.deviceLicensing === true && a.intent === "required" && ctx.kindOf(a.groupId) === "users")
              .map((a) =>
                finding(
                  `${item.name} has a device licence but goes to ${ctx.nameOf(a.groupId)}, which contains only users. ` +
                    "The app follows the users and takes one licence per device they sign in on.",
                  { groups: [a.groupId], items: [item.id] }
                )
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
        const targets = [...new Set(required.map((a) => ctx.nameOf(a.groupId)))];
        const via = targets.length > 3 ? `${targets.slice(0, 3).join(", ")} and ${targets.length - 3} more` : targets.join(", ");
        return [
          finding(
            `${item.name}: ${item.totalLicenses} licences, ${atLeast(need, capped)} required recipients via ${via}. ` +
              "Those who do not get a licence get an install error.",
            { groups: required.map((a) => a.groupId), items: [item.id] }
          )
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
          finding(`${item.name}: all ${item.totalLicenses} licences are used up.`, { items: [item.id] })
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
          .map((a) =>
            finding(
              `${item.name} is for ${item.platform} but goes to ${ctx.nameOf(a.groupId)}, ` +
                `where the devices are ${osList(ctx.subtree(a.groupId).devices)}. Nothing happens.`,
              { groups: [a.groupId], items: [item.id] }
            )
          );
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
            return finding(
              `${item.name} excludes ${ctx.nameOf(a.groupId)} (${kind === "users" ? "users" : "devices"}) ` +
                `from an assignment to ${kind === "users" ? "devices" : "users"}. ` +
                "Intune cannot mix the kinds — the exclusion does not apply.",
              { groups: [a.groupId], items: [item.id] }
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
                finding(
                  `${item.name} goes to ${ctx.nameOf(parent.groupId)} but excludes ${ctx.nameOf(ex.groupId)}, ` +
                    "which sits inside it. Is that still right?",
                  { groups: [parent.groupId, ex.groupId], items: [item.id] }
                )
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
              finding(
                `${item.name} is installed to ${ctx.nameOf(a.groupId)} and uninstalled from ${ctx.nameOf(b.groupId)}. ` +
                  `They meet in ${ctx.nameOf(shared)}, where the outcome is decided by Intune's conflict rules.`,
                { groups: [a.groupId, b.groupId], items: [item.id] }
              )
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
          if (!list.includes(item.name)) list.push(item.name);
          byGroup.set(a.groupId, list);
        }
      }
      return [...byGroup].map(([id, names]) => {
        const rule = ctx.forest.nodeById.get(id)?.membershipRule;
        return finding(
          `${ctx.nameOf(id)} is empty but has ${names.join(", ")}.` +
            (rule ? ` The group is dynamic — is the rule right? ${rule}` : ""),
          { groups: [id] }
        );
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
            finding(
              `${item.name} is assigned to a group that no longer exists (${a.groupId}). ` +
                "It does not show in the portal's group lists, and nobody gets what was intended.",
              { groups: [a.groupId], items: [item.id] }
            )
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
                return finding(
                  `${item.name} goes to ${ctx.nameOf(a.groupId)}, where ${s.disabled} of ${s.users} accounts are disabled. ` +
                    "The licences are locked up with them.",
                  { groups: [a.groupId], items: [item.id] }
                );
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
              finding(
                `${a.item.name} and ${b.item.name} both apply to ${a.item.ssid} and meet in ${ctx.nameOf(shared)}. ` +
                  "Which one wins varies from device to device.",
                { groups: [shared], items: [a.item.id, b.item.id] }
              )
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
                finding(
                  `${item.name} goes to ${ctx.nameOf(a.groupId)}, which has both users and devices directly in it. ` +
                    "The profile then also reaches the users' own devices.",
                  { groups: [a.groupId], items: [item.id] }
                )
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
              finding(`${item.name}: ${ctx.nameOf(inner.groupId)} is already part of ${ctx.nameOf(outer.groupId)}.`, {
                groups: [outer.groupId, inner.groupId],
                items: [item.id]
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

        const affected = ctx.byItem
          .filter(({ includes }) => includes.some((a) => ring.includes(a.groupId)))
          .map(({ item }) => item.name);

        found.push(
          finding(
            `${ring.map(ctx.nameOf).join(" ↔ ")} contain each other.` +
              (affected.length ? ` Assigned there: ${affected.join(", ")} — unclear who actually gets it.` : ""),
            { groups: ring }
          )
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
          byGroup.set(a.groupId, [...(byGroup.get(a.groupId) ?? []), item.name]);
        }
      }
      return [...byGroup].map(([id, names]) =>
        finding(
          `${ctx.nameOf(id)} reaches ${depthOf(ctx, id)} levels down and ${ctx.descendants(id).size - 1} groups. ` +
            `Assigned: ${[...new Set(names)].join(", ")}.`,
          { groups: [id] }
        )
      );
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
          return finding(
            `${list[0].name} exists ${list.length} times` +
              (orgs.length > 1 ? `, from different VPP tokens: ${orgs.join(" and ")}.` : "."),
            { items: list.map((i) => i.id) }
          );
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
          finding(`${item.name} goes to all users — staff get the restrictions too.`, { items: [item.id] })
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
                return finding(
                  `${item.name} goes to ${ctx.nameOf(a.groupId)} with ${atLeast(s.deviceCount, s.capped)} devices. ` +
                    "All of them are locked to the kiosk apps at the next sync.",
                  { groups: [a.groupId], items: [item.id] }
                );
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
            finding(
              `${ctx.nameOf(child)} (users) sits in ${ctx.nameOf(id)}, where the other subgroups are devices. ` +
                "Device profiles for the group now reach all of the users' devices.",
              { groups: [id, child] }
            )
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
            finding(
              `${rings[i].item.name} and ${rings[j].item.name} both hit ${ctx.nameOf(shared)}. ` +
                "The devices there get two sets of update rules.",
              { groups: [shared], items: [rings[i].item.id, rings[j].item.id] }
            )
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
          finding(
            `At least ${n} ${os} devices, but no compliance policy for ${os} is assigned. ` +
              "The devices are then counted as compliant without anything being checked."
          )
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
          finding(`${item.name} has ${item.usedLicenses} used licences but no assignment. They are not freed by themselves.`, {
            items: [item.id]
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
          finding(`${item.name} is uninstalled from everyone — even where it is needed.`, { items: [item.id] })
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
            finding(
              `${item.name} is both assigned and excluded for ${ctx.nameOf(ex.groupId)}. The exclusion wins — nobody there gets it.`,
              { groups: [ex.groupId], items: [item.id] }
            )
          )
      )
  },
  {
    id: "expiring-connections",
    title: "Connections that are expiring",
    severity: "warn",
    right: `No tokens or certificates expire within ${EXPIRY_WARN_DAYS} days.`,
    needs: ["connections"],
    run: (ctx) =>
      (ctx.connections?.items ?? [])
        .filter((c) => c.expires)
        .map((c) => ({ c, days: Math.floor((new Date(c.expires).getTime() - ctx.now) / DAY) }))
        .filter(({ days }) => days <= EXPIRY_WARN_DAYS)
        .map(({ c, days }) =>
          finding(
            days < 0
              ? `${c.sourceLabel}: ${c.name} expired ${-days} days ago.`
              : `${c.sourceLabel}: ${c.name} expires in ${days} days.`
          )
        )
  }
];

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
          text: finding.text
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
