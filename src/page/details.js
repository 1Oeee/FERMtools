// Detaljpanelen för vald grupp.

import { describeGroup, isDynamic } from "../graph/groups.js";
import { showPortal } from "./embed.js";

const INTUNE_GROUP =
  "https://intune.microsoft.com/#view/Microsoft_AAD_IAM/GroupDetailsMenuBlade/~/Overview/groupId/";
const ENTRA_GROUP =
  "https://entra.microsoft.com/#view/Microsoft_AAD_IAM/GroupDetailsMenuBlade/~/Overview/groupId/";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function section(title, count) {
  const head = el("div", "d-head");
  head.append(el("span", null, title));
  if (count !== undefined) head.append(el("span", "count", String(count)));
  return head;
}

function itemList(items, emptyText) {
  if (!items?.length) return el("div", "d-empty", emptyText);

  const list = el("ul", "d-list");
  for (const item of items) {
    const li = el("li");
    li.append(el("span", "d-name", item.name));
    li.append(el("span", "d-src", item.sourceLabel));
    list.append(li);
  }
  return list;
}

function groupLinks(ids, nodeById, onPick, emptyText) {
  if (!ids?.length) return el("div", "d-empty", emptyText);

  const list = el("ul", "d-list");
  for (const id of ids) {
    const li = el("li");
    const link = el("button", "linklike", nodeById.get(id)?.displayName ?? id);
    link.type = "button";
    link.addEventListener("click", () => onPick(id));
    li.append(link);
    list.append(li);
  }
  return list;
}

async function copy(text, button) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Kopierat";
  } catch {
    button.textContent = "Gick inte";
  }
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

/**
 * Intune öppnas i fliken vi redan står i — en ny flik vore bara dubbelt.
 * Ligger AidTune över portalens yta fälls sidan undan på köpet, annars hade
 * bladet hamnat bakom den.
 *
 * Helst just den portalflik sidan ligger i: med flera tenanter öppna står
 * en annan portalflik kanske i en annan kund, och där finns inte gruppen.
 */
function openInIntuneTab(url) {
  chrome.tabs.getCurrent((current) => {
    void chrome.runtime.lastError;
    chrome.tabs.query({ url: "https://intune.microsoft.com/*" }, (tabs) => {
      if (chrome.runtime.lastError || !tabs?.length) {
        chrome.tabs.create({ url });
        return;
      }
      const tab = tabs.find((t) => t.id === current?.id) ?? tabs[0];
      chrome.tabs.update(tab.id, { url, active: true });
      chrome.windows.update(tab.windowId, { focused: true });
      showPortal();
    });
  });
}

/** Entra är en annan portal — den får inte ta över Intune-fliken. */
function openInNewTab(url) {
  chrome.tabs.create({ url });
}

/**
 * @param {HTMLElement} container
 * @param {{ forest, flags, assignments, selectedId, onPick, requestMembers }} ctx
 */
export function renderDetails(container, ctx) {
  const { forest, assignments, selectedId, onPick, requestMembers } = ctx;
  const { collapsed = false, onToggleCollapse = null } = ctx;

  container.classList.toggle("collapsed", collapsed);

  if (!selectedId) {
    container.replaceChildren(el("div", "d-empty", "Välj en grupp i trädet."));
    return;
  }

  const group = forest.nodeById.get(selectedId);
  if (!group) {
    container.replaceChildren(el("div", "d-empty", "Gruppen finns inte i urvalet."));
    return;
  }

  const bucket = assignments.get(selectedId) ?? { configs: [], apps: [], excludedBy: [] };

  // Rubriken står kvar när panelen är hopfälld, så man ser vad som är valt.
  const title = el("div", "d-title");
  const heading = el("div", "d-heading");
  heading.append(el("div", "d-groupname", group.displayName));

  if (onToggleCollapse) {
    const toggle = el("button", "d-collapse", collapsed ? "⌃" : "⌄");
    toggle.type = "button";
    toggle.title = collapsed ? "Visa detaljer" : "Fäll ihop detaljer";
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.addEventListener("click", onToggleCollapse);
    heading.append(toggle);
  }

  title.append(heading);

  const body = el("div", "d-body");
  body.append(el("div", "d-kind", describeGroup(group)));

  if (group.description) body.append(el("div", "d-desc", group.description));

  if (isDynamic(group)) {
    body.append(section("Medlemsregel"));
    body.append(el("pre", "d-rule", group.membershipRule));
  }

  body.append(section("Konfigurationer", bucket.configs.length));
  body.append(itemList(bucket.configs, "Inga konfigurationer tilldelade direkt här."));

  body.append(section("Appar", bucket.apps.length));
  body.append(itemList(bucket.apps, "Inga appar tilldelade direkt här."));

  if (bucket.excludedBy.length) {
    body.append(section("Exkluderad från", bucket.excludedBy.length));
    body.append(itemList(bucket.excludedBy, ""));
  }

  const children = forest.childrenOf.get(selectedId) ?? [];
  body.append(section("Undergrupper", children.length));
  body.append(groupLinks(children, forest.nodeById, onPick, "Inga undergrupper."));

  const parents = forest.parentsOf.get(selectedId) ?? [];
  if (parents.length) {
    body.append(section("Ligger under", parents.length));
    body.append(groupLinks(parents, forest.nodeById, onPick, ""));
  }

  // Medlemmar hämtas först när panelen öppnas, inte vid varje trädbygge.
  body.append(section("Medlemmar"));
  const members = el("div", "d-empty", "Hämtar …");
  body.append(members);

  const id = el("div", "d-id");
  id.append(el("code", null, selectedId));
  const copyBtn = el("button", "secondary small", "Kopiera ID");
  copyBtn.type = "button";
  copyBtn.addEventListener("click", () => copy(selectedId, copyBtn));
  id.append(copyBtn);
  body.append(id);

  const links = el("div", "d-links");
  for (const [label, base, launch, hint] of [
    ["Öppna i Intune", INTUNE_GROUP, openInIntuneTab, "Byter blad i portalfliken"],
    ["Öppna i Entra", ENTRA_GROUP, openInNewTab, "Öppnas i en ny flik"]
  ]) {
    const button = el("button", "secondary small", label);
    button.type = "button";
    button.title = hint;
    button.addEventListener("click", () => launch(base + selectedId));
    links.append(button);
  }
  body.append(links);

  container.replaceChildren(title, body);

  // Hopfälld panel hämtar inga medlemmar — det vore ett anrop ingen ser.
  if (collapsed) return;

  requestMembers(selectedId).then((result) => {
    // Användaren kan ha hunnit välja en annan grupp under tiden.
    if (!members.isConnected) return;

    if (!result?.ok) {
      members.textContent = `Kunde inte hämta medlemmar: ${result?.error ?? "okänt fel"}`;
      return;
    }

    const { users = [], devices = [] } = result;
    if (!users.length && !devices.length) {
      members.textContent = "Inga direkta användar- eller enhetsmedlemmar.";
      return;
    }

    const list = el("ul", "d-list");
    for (const user of users.slice(0, 50)) {
      const li = el("li");
      li.append(el("span", "d-name", user.displayName ?? user.userPrincipalName ?? user.id));
      li.append(el("span", "d-src", "användare"));
      list.append(li);
    }
    for (const device of devices.slice(0, 50)) {
      const li = el("li");
      li.append(el("span", "d-name", device.displayName ?? device.id));
      li.append(el("span", "d-src", "enhet"));
      list.append(li);
    }

    const shown = Math.min(users.length, 50) + Math.min(devices.length, 50);
    const total = users.length + devices.length;
    members.replaceWith(list);
    if (shown < total) {
      list.after(el("div", "d-empty", `Visar ${shown} av ${total}.`));
    }
  });
}
