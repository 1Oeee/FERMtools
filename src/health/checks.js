// Hälsokontroll: regler för rätt och fel i en tenants tilldelningar.
//
// Varje kontroll beskriver hur det *ska* se ut (`right`) och letar efter det
// som avviker. Allt är rena funktioner över data som redan hämtats — inget
// nätverk, ingen DOM — så att reglerna kan testas mot demotenanten.
//
// Underlaget:
//   groups, edges        trädets grupper och kanter
//   items, assignments   poster och platta tilldelningar ur assignments.js
//   composition          vad varje grupp innehåller direkt (groups.js)
//   outside, deleted     uppslag av grupp-id som inte finns i trädet
//   connections          Connections-flikens poster, om de hämtats
//
// Antal medlemmar är golv, inte exakta siffror: bara första sidan per grupp
// läses. Texterna säger "minst" där det spelar roll.

import { buildForest } from "../tree/build.js";

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
    if (!name) return deleted.has(id) ? "(borttagen grupp)" : "(okänd grupp)";
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
    .map(([os]) => (os === "other" ? "övriga" : os))
    .join(", ");
const atLeast = (n, capped) => (capped ? `minst ${n}` : String(n));

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
    title: "Användarlicens till enhetsgrupp",
    severity: "bad",
    right: "Användarlicensierade VPP-appar går till grupper med användare.",
    needs: ["composition"],
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes }) =>
        isVpp(item)
          ? includes
              .filter((a) => a.deviceLicensing === false && ctx.kindOf(a.groupId) === "devices")
              .map((a) =>
                finding(
                  `${item.name} har användarlicens men går till ${ctx.nameOf(a.groupId)}, som bara innehåller enheter. ` +
                    "Utan inloggad användare kan licensen aldrig lösas in.",
                  { groups: [a.groupId], items: [item.id] }
                )
              )
          : []
      )
  },
  {
    id: "available-to-devices",
    title: "\"Tillgänglig\" till enhetsgrupp",
    severity: "bad",
    right: "Appar som väljs i Företagsportalen går till användargrupper.",
    needs: ["composition"],
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes, allDevices }) => [
        ...includes
          .filter((a) => a.intent === "available" && ctx.kindOf(a.groupId) === "devices")
          .map((a) =>
            finding(
              `${item.name} är tillgänglig för ${ctx.nameOf(a.groupId)}, som bara innehåller enheter. ` +
                "Tillgänglig fungerar bara mot användare — appen syns ingenstans.",
              { groups: [a.groupId], items: [item.id] }
            )
          ),
        ...allDevices
          .filter((a) => a.intent === "available")
          .map((a) => finding(`${item.name} är tillgänglig för alla enheter — det syns ingenstans.`, { items: [item.id] }))
      ])
  },
  {
    id: "device-licence-to-users",
    title: "Enhetslicens till användargrupp",
    severity: "warn",
    right: "Enhetslicensierade VPP-appar går till enhetsgrupper.",
    needs: ["composition"],
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes }) =>
        isVpp(item)
          ? includes
              .filter((a) => a.deviceLicensing === true && a.intent === "required" && ctx.kindOf(a.groupId) === "users")
              .map((a) =>
                finding(
                  `${item.name} har enhetslicens men går till ${ctx.nameOf(a.groupId)}, som bara innehåller användare. ` +
                    "Appen följer användarna och tar en licens per enhet de loggar in på.",
                  { groups: [a.groupId], items: [item.id] }
                )
              )
          : []
      )
  },
  {
    id: "licence-overcommit",
    title: "Fler mottagare än licenser",
    severity: "bad",
    right: "Varje VPP-app har licenser nog för sina obligatoriska mottagare.",
    needs: ["composition"],
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes }) => {
        if (!isVpp(item)) return [];
        const required = includes.filter((a) => a.intent === "required");
        if (!required.length) return [];

        // Samma grupp kan nås från flera tilldelningar — räkna den en gång.
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
        const via = targets.length > 3 ? `${targets.slice(0, 3).join(", ")} och ${targets.length - 3} till` : targets.join(", ");
        return [
          finding(
            `${item.name}: ${item.totalLicenses} licenser, ${atLeast(need, capped)} obligatoriska mottagare via ${via}. ` +
              "De som inte får licens får ett installationsfel.",
            { groups: required.map((a) => a.groupId), items: [item.id] }
          )
        ];
      })
  },
  {
    id: "licences-exhausted",
    title: "Slut på licenser",
    severity: "info",
    right: "Alla VPP-appar har lediga licenser.",
    run: (ctx) =>
      ctx.byItem
        .filter(({ item }) => isVpp(item) && item.totalLicenses > 0 && item.usedLicenses >= item.totalLicenses)
        .map(({ item }) =>
          finding(`${item.name}: alla ${item.totalLicenses} licenser är förbrukade.`, { items: [item.id] })
        )
  },
  {
    id: "platform-mismatch",
    title: "Fel plattform",
    severity: "bad",
    right: "Appar och profiler går till enheter med rätt plattform.",
    needs: ["composition"],
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes }) => {
        if (!item.platform) return [];
        return includes
          .filter((a) => {
            if (ctx.kindOf(a.groupId) !== "devices") return false;
            const s = ctx.subtree(a.groupId);
            // iPadOS och macOS delar ibland appar; räkna dem inte som fel mot varandra.
            const fits = s.devices[item.platform] + (item.platform === "iOS" ? s.devices.macOS : 0);
            return fits === 0;
          })
          .map((a) =>
            finding(
              `${item.name} är för ${item.platform} men går till ${ctx.nameOf(a.groupId)}, ` +
                `där enheterna är ${osList(ctx.subtree(a.groupId).devices)}. Ingenting händer.`,
              { groups: [a.groupId], items: [item.id] }
            )
          );
      })
  },
  {
    id: "mixed-exclusion",
    title: "Undantag av fel sort",
    severity: "bad",
    right: "Undantag är av samma sort som tilldelningen — användare mot användare, enheter mot enheter.",
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
              `${item.name} undantar ${ctx.nameOf(a.groupId)} (${kind === "users" ? "användare" : "enheter"}) ` +
                `från en tilldelning till ${kind === "users" ? "enheter" : "användare"}. ` +
                "Intune kan inte blanda sorterna — undantaget gäller inte.",
              { groups: [a.groupId], items: [item.id] }
            );
          });
      })
  },
  {
    id: "exclusion-inside-target",
    title: "Undantag inuti en tilldelad grupp",
    severity: "info",
    right: "Inga undantag som behöver dubbelkollas.",
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes, excludes }) =>
        excludes.flatMap((ex) => {
          const parent = includes.find((a) => a.groupId !== ex.groupId && ctx.descendants(a.groupId).has(ex.groupId));
          return parent
            ? [
                finding(
                  `${item.name} går till ${ctx.nameOf(parent.groupId)} men undantar ${ctx.nameOf(ex.groupId)}, ` +
                    "som ligger inuti. Stämmer det fortfarande?",
                  { groups: [parent.groupId, ex.groupId], items: [item.id] }
                )
              ]
            : [];
        })
      )
  },
  {
    id: "intent-conflict",
    title: "Installera och avinstallera samtidigt",
    severity: "bad",
    right: "Ingen app installeras och avinstalleras på samma mottagare.",
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
                `${item.name} installeras till ${ctx.nameOf(a.groupId)} och avinstalleras från ${ctx.nameOf(b.groupId)}. ` +
                  `De möts i ${ctx.nameOf(shared)}, där utfallet avgörs av Intunes konfliktregler.`,
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
    title: "Tilldelat till tom grupp",
    severity: "warn",
    right: "Alla tilldelade grupper har medlemmar.",
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
          `${ctx.nameOf(id)} är tom men har ${names.join(", ")}.` +
            (rule ? ` Gruppen är dynamisk — stämmer regeln? ${rule}` : ""),
          { groups: [id] }
        );
      });
    }
  },
  {
    id: "deleted-target",
    title: "Tilldelning till borttagen grupp",
    severity: "bad",
    right: "Inga tilldelningar pekar på grupper som tagits bort.",
    needs: ["lookup"],
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes, excludes }) =>
        [...includes, ...excludes]
          .filter((a) => ctx.deleted.has(a.groupId))
          .map((a) =>
            finding(
              `${item.name} är tilldelad en grupp som inte finns längre (${a.groupId}). ` +
                "Den syns inte i portalens grupplistor, och ingen får det som var tänkt.",
              { groups: [a.groupId], items: [item.id] }
            )
          )
      )
  },
  {
    id: "disabled-users",
    title: "Licenser hos inaktiverade konton",
    severity: "warn",
    right: "Inga VPP-licenser går till grupper där kontona är inaktiverade.",
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
                  `${item.name} går till ${ctx.nameOf(a.groupId)}, där ${s.disabled} av ${s.users} konton är inaktiverade. ` +
                    "Licenserna ligger låsta hos dem.",
                  { groups: [a.groupId], items: [item.id] }
                );
              })
          : []
      )
  },
  {
    id: "duplicate-ssid",
    title: "Flera Wi-Fi-profiler för samma nätverk",
    severity: "warn",
    right: "Varje Wi-Fi-nätverk har en profil per plattform.",
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
                `${a.item.name} och ${b.item.name} gäller båda ${a.item.ssid} och möts i ${ctx.nameOf(shared)}. ` +
                  "Vilken som vinner varierar från enhet till enhet.",
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
    title: "Profil till grupp med både användare och enheter",
    severity: "warn",
    right: "Profiler går till grupper med antingen användare eller enheter.",
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
                  `${item.name} går till ${ctx.nameOf(a.groupId)}, som har både användare och enheter direkt i sig. ` +
                    "Profilen når då även användarnas egna enheter.",
                  { groups: [a.groupId], items: [item.id] }
                )
              )
          : []
      )
  },
  {
    id: "redundant-assignment",
    title: "Dubbel tilldelning via nästling",
    severity: "info",
    right: "Ingen post är tilldelad både en grupp och en grupp inuti den.",
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes }) => {
        const found = [];
        for (const outer of includes) {
          for (const inner of includes) {
            if (outer === inner || outer.groupId === inner.groupId || outer.intent !== inner.intent) continue;
            if (!ctx.descendants(outer.groupId).has(inner.groupId)) continue;
            found.push(
              finding(`${item.name}: ${ctx.nameOf(inner.groupId)} ingår redan i ${ctx.nameOf(outer.groupId)}.`, {
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
    title: "Cirkulärt medlemskap",
    severity: "warn",
    right: "Inga grupper innehåller sig själva via andra grupper.",
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
            `${ring.map(ctx.nameOf).join(" ↔ ")} innehåller varandra.` +
              (affected.length ? ` Tilldelat där: ${affected.join(", ")} — oklart vilka som faktiskt får det.` : ""),
            { groups: ring }
          )
        );
      }
      return found;
    }
  },
  {
    id: "deep-nesting",
    title: "Djup nästling",
    severity: "info",
    right: `Tilldelade grupper är högst ${DEEP - 1} nivåer djupa, så räckvidden går att överblicka.`,
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
          `${ctx.nameOf(id)} når ${depthOf(ctx, id)} nivåer ner och ${ctx.descendants(id).size - 1} grupper. ` +
            `Tilldelat: ${[...new Set(names)].join(", ")}.`,
          { groups: [id] }
        )
      );
    }
  },
  {
    id: "duplicate-item",
    title: "Samma app eller profil flera gånger",
    severity: "warn",
    right: "Varje app och profil finns en gång.",
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
            `${list[0].name} finns ${list.length} gånger` +
              (orgs.length > 1 ? `, från olika VPP-tokens: ${orgs.join(" och ")}.` : "."),
            { items: list.map((i) => i.id) }
          );
        });
    }
  },
  {
    id: "restriction-all-users",
    title: "Begränsningar till alla användare",
    severity: "warn",
    right: "Begränsningsprofiler går till avgränsade grupper, inte till alla användare.",
    run: (ctx) =>
      ctx.byItem
        .filter(({ item, allUsers }) => allUsers.length && /GeneralDeviceConfiguration$|GeneralConfiguration$|Restriction/i.test(item.type ?? ""))
        .map(({ item }) =>
          finding(`${item.name} går till alla användare — även personalen får begränsningarna.`, { items: [item.id] })
        )
  },
  {
    id: "kiosk-large",
    title: "Kioskläge på en stor grupp",
    severity: "bad",
    right: `Kioskprofiler går bara till små enhetsgrupper (högst ${KIOSK_MAX_DEVICES} enheter).`,
    needs: ["composition"],
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes }) =>
        /kiosk/i.test(item.type ?? "")
          ? includes
              .filter((a) => ctx.subtree(a.groupId).deviceCount > KIOSK_MAX_DEVICES)
              .map((a) => {
                const s = ctx.subtree(a.groupId);
                return finding(
                  `${item.name} går till ${ctx.nameOf(a.groupId)} med ${atLeast(s.deviceCount, s.capped)} enheter. ` +
                    "Alla låses till kioskens appar vid nästa synk.",
                  { groups: [a.groupId], items: [item.id] }
                );
              })
          : []
      )
  },
  {
    id: "users-in-device-branch",
    title: "Användargrupp bland enhetsgrupper",
    severity: "warn",
    right: "Användargrupper ligger inte nästlade bland enhetsgrupper.",
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
              `${ctx.nameOf(child)} (användare) ligger i ${ctx.nameOf(id)}, där övriga undergrupper är enheter. ` +
                "Enhetsprofiler till gruppen når nu användarnas alla enheter.",
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
    title: "Överlappande uppdateringsringar",
    severity: "bad",
    right: "Varje enhet ligger i en enda uppdateringsring.",
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
              `${rings[i].item.name} och ${rings[j].item.name} träffar båda ${ctx.nameOf(shared)}. ` +
                "Enheterna där får två uppsättningar uppdateringsregler.",
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
    title: "Plattform utan efterlevnadsprincip",
    severity: "bad",
    right: "Varje plattform med enheter har en tilldelad efterlevnadsprincip.",
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
            `Minst ${n} ${os}-enheter, men ingen efterlevnadsprincip för ${os} är tilldelad. ` +
              "Enheterna räknas då som kompatibla utan att något kontrollerats."
          )
        );
    }
  },
  {
    id: "licences-without-assignment",
    title: "Förbrukade licenser utan tilldelning",
    severity: "warn",
    right: "Inga VPP-licenser är förbrukade av appar som inte längre är tilldelade.",
    run: (ctx) => {
      const assigned = new Set(ctx.byItem.map(({ item }) => item.id));
      return [...ctx.items.values()]
        .filter((item) => isVpp(item) && item.usedLicenses > 0 && !assigned.has(item.id))
        .map((item) =>
          finding(`${item.name} har ${item.usedLicenses} förbrukade licenser men ingen tilldelning. De frigörs inte av sig själva.`, {
            items: [item.id]
          })
        );
    }
  },
  {
    id: "uninstall-to-everyone",
    title: "Avinstallation till alla",
    severity: "bad",
    right: "Ingen app avinstalleras från alla användare eller alla enheter.",
    run: (ctx) =>
      ctx.byItem
        .filter(({ allDevices, allUsers }) => [...allDevices, ...allUsers].some((a) => a.intent === "uninstall"))
        .map(({ item }) =>
          finding(`${item.name} avinstalleras från alla — även där den behövs.`, { items: [item.id] })
        )
  },
  {
    id: "include-and-exclude-same",
    title: "Samma grupp tilldelad och undantagen",
    severity: "warn",
    right: "Ingen grupp är både tilldelad och undantagen från samma post.",
    run: (ctx) =>
      ctx.byItem.flatMap(({ item, includes, excludes }) =>
        excludes
          .filter((ex) => includes.some((a) => a.groupId === ex.groupId))
          .map((ex) =>
            finding(
              `${item.name} är både tilldelad och undantagen för ${ctx.nameOf(ex.groupId)}. Undantaget vinner — ingen där får den.`,
              { groups: [ex.groupId], items: [item.id] }
            )
          )
      )
  },
  {
    id: "expiring-connections",
    title: "Anslutningar som går ut",
    severity: "warn",
    right: `Inga tokens eller certifikat går ut inom ${EXPIRY_WARN_DAYS} dagar.`,
    needs: ["connections"],
    run: (ctx) =>
      (ctx.connections?.items ?? [])
        .filter((c) => c.expires)
        .map((c) => ({ c, days: Math.floor((new Date(c.expires).getTime() - ctx.now) / DAY) }))
        .filter(({ days }) => days <= EXPIRY_WARN_DAYS)
        .map(({ c, days }) =>
          finding(
            days < 0
              ? `${c.sourceLabel}: ${c.name} gick ut för ${-days} dagar sedan.`
              : `${c.sourceLabel}: ${c.name} går ut om ${days} dagar.`
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
    const base = { id: check.id, title: check.title, severity: check.severity, right: check.right };
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
