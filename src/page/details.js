// Details panel for the selected group.

import { describeGroup, isDynamic } from "../graph/groups.js";
import { showPortal } from "./embed.js";

const INTUNE_GROUP =
  "https://intune.microsoft.com/#view/Microsoft_AAD_IAM/GroupDetailsMenuBlade/~/Overview/groupId/";

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
    button.textContent = "Copied";
  } catch {
    button.textContent = "Failed";
  }
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

/**
 * Intune opens in the tab we are already in — a new tab would be redundant.
 * If AidTune sits over the portal surface the page is folded away too,
 * otherwise the blade would end up behind it.
 */
function openInIntuneTab(url) {
  chrome.tabs.query({ url: "https://intune.microsoft.com/*" }, (tabs) => {
    if (chrome.runtime.lastError || !tabs?.length) {
      chrome.tabs.create({ url });
      return;
    }
    chrome.tabs.update(tabs[0].id, { url, active: true });
    chrome.windows.update(tabs[0].windowId, { focused: true });
    showPortal();
  });
}

const MARK = { bad: "✗", warn: "!", info: "i" };
const SHORT = 170;

/** First sentence, or a truncation at a word boundary. The full text is in the tab. */
function shorten(text) {
  const sentence = text.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? text;
  if (sentence.length <= SHORT) return sentence;
  const cut = sentence.slice(0, SHORT);
  return `${cut.slice(0, cut.lastIndexOf(" ")) || cut} …`;
}

/**
 * The group's health check findings, in brief. Each finding links to its entry in
 * the Health check tab, where the full explanation is.
 */
function healthSection(health) {
  const box = el("div", "d-health");
  const findings = health.findings ?? [];
  box.append(section("Health check", findings.length || undefined));

  if (!findings.length) {
    box.append(
      el("div", "d-empty", health.loading && !health.ready ? "Checking …" : "No problems with this group.")
    );
    if (health.below) {
      box.append(el("div", `d-issue-below ${health.below.severity}`, `${health.below.count} finding(s) further down the branch.`));
    }
    return box;
  }

  for (const finding of findings) {
    const item = el("div", `d-issue ${finding.severity}`);
    const head = el("div", "d-issue-head");
    head.append(el("span", `d-issue-mark ${finding.severity}`, MARK[finding.severity]), el("strong", null, finding.title));
    item.append(head);
    item.append(el("div", "d-issue-text", shorten(finding.text)));

    const link = el("button", "linklike d-issue-link", "Show in Health check →");
    link.type = "button";
    link.addEventListener("click", () => health.onOpen(finding.ref));
    item.append(link);
    box.append(item);
  }
  return box;
}

/**
 * @param {HTMLElement} container
 * @param {{ forest, flags, assignments, selectedId, onPick, requestMembers, health? }} ctx
 */
export function renderDetails(container, ctx) {
  const { forest, assignments, selectedId, onPick, requestMembers } = ctx;
  const { collapsed = false, onToggleCollapse = null } = ctx;

  container.classList.toggle("collapsed", collapsed);

  if (!selectedId) {
    container.replaceChildren(el("div", "d-empty", "Select a group in the tree."));
    return;
  }

  const group = forest.nodeById.get(selectedId);
  if (!group) {
    container.replaceChildren(el("div", "d-empty", "The group is not in the current selection."));
    return;
  }

  const bucket = assignments.get(selectedId) ?? { configs: [], apps: [], excludedBy: [] };

  // The heading stays when the panel is collapsed, so you can see what is selected.
  const title = el("div", "d-title");
  const heading = el("div", "d-heading");
  heading.append(el("div", "d-groupname", group.displayName));

  if (onToggleCollapse) {
    const toggle = el("button", "d-collapse", collapsed ? "⌃" : "⌄");
    toggle.type = "button";
    toggle.title = collapsed ? "Show details" : "Collapse details";
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.addEventListener("click", onToggleCollapse);
    heading.append(toggle);
  }

  title.append(heading);

  const body = el("div", "d-body");
  body.append(el("div", "d-kind", describeGroup(group)));

  if (group.description) body.append(el("div", "d-desc", group.description));

  // Problems first: that is what you want to see after clicking a flagged group.
  if (ctx.health) body.append(healthSection(ctx.health));

  if (isDynamic(group)) {
    body.append(section("Membership rule"));
    body.append(el("pre", "d-rule", group.membershipRule));
  }

  body.append(section("Configurations", bucket.configs.length));
  body.append(itemList(bucket.configs, "No configurations assigned directly here."));

  body.append(section("Apps", bucket.apps.length));
  body.append(itemList(bucket.apps, "No apps assigned directly here."));

  if (bucket.excludedBy.length) {
    body.append(section("Excluded from", bucket.excludedBy.length));
    body.append(itemList(bucket.excludedBy, ""));
  }

  const children = forest.childrenOf.get(selectedId) ?? [];
  body.append(section("Subgroups", children.length));
  body.append(groupLinks(children, forest.nodeById, onPick, "No subgroups."));

  const parents = forest.parentsOf.get(selectedId) ?? [];
  if (parents.length) {
    body.append(section("Member of", parents.length));
    body.append(groupLinks(parents, forest.nodeById, onPick, ""));
  }

  // Members are fetched only when the panel is opened, not on every tree build.
  body.append(section("Members"));
  const members = el("div", "d-empty", "Loading …");
  body.append(members);

  const id = el("div", "d-id");
  id.append(el("code", null, selectedId));
  const copyBtn = el("button", "secondary small", "Copy ID");
  copyBtn.type = "button";
  copyBtn.addEventListener("click", () => copy(selectedId, copyBtn));
  id.append(copyBtn);
  body.append(id);

  const links = el("div", "d-links");
  for (const [label, base, launch, hint] of [
    ["Open group", INTUNE_GROUP, openInIntuneTab, "Switches the blade in the portal tab"]
  ]) {
    const button = el("button", "secondary small", label);
    button.type = "button";
    button.title = hint;
    button.addEventListener("click", () => launch(base + selectedId));
    links.append(button);
  }
  body.append(links);

  container.replaceChildren(title, body);

  // A collapsed panel fetches no members — it would be a request nobody sees.
  if (collapsed) return;

  requestMembers(selectedId).then((result) => {
    // The user may have selected another group in the meantime.
    if (!members.isConnected) return;

    if (!result?.ok) {
      members.textContent = `Could not fetch members: ${result?.error ?? "unknown error"}`;
      return;
    }

    const { users = [], devices = [] } = result;
    if (!users.length && !devices.length) {
      members.textContent = "No direct user or device members.";
      return;
    }

    const list = el("ul", "d-list");
    for (const user of users.slice(0, 50)) {
      const li = el("li");
      li.append(el("span", "d-name", user.displayName ?? user.userPrincipalName ?? user.id));
      li.append(el("span", "d-src", "user"));
      list.append(li);
    }
    for (const device of devices.slice(0, 50)) {
      const li = el("li");
      li.append(el("span", "d-name", device.displayName ?? device.id));
      li.append(el("span", "d-src", "device"));
      list.append(li);
    }

    const shown = Math.min(users.length, 50) + Math.min(devices.length, 50);
    const total = users.length + devices.length;
    members.replaceWith(list);
    if (shown < total) {
      list.after(el("div", "d-empty", `Showing ${shown} of ${total}.`));
    }
  });
}
