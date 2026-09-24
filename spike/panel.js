const tokenEl = document.getElementById("token");
const resultsEl = document.getElementById("results");
const refreshBtn = document.getElementById("refresh");
const probeBtn = document.getElementById("probe");

const GROUP_SCOPES = [
  "Group.Read.All",
  "GroupMember.Read.All",
  "Directory.Read.All",
  "Directory.AccessAsUser.All"
];

const INTUNE_SCOPES = [
  "DeviceManagementApps.Read.All",
  "DeviceManagementApps.ReadWrite.All",
  "DeviceManagementConfiguration.Read.All",
  "DeviceManagementConfiguration.ReadWrite.All"
];

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(response);
    });
  });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function row(key, value) {
  const r = el("div", "row");
  r.append(el("span", "k", key), el("span", "v", value));
  return r;
}

function pills(all, have) {
  const wrap = el("div");
  for (const s of all) {
    const got = have.includes(s);
    wrap.append(el("span", got ? "pill have" : "pill", (got ? "✓ " : "· ") + s));
  }
  return wrap;
}

function minutes(seconds) {
  return `${Math.floor(seconds / 60)} min`;
}

function renderStatus(status) {
  tokenEl.replaceChildren();

  if (!status) {
    tokenEl.append(el("div", "muted", "Servicearbetaren svarar inte. Läs in tillägget igen."));
    probeBtn.disabled = true;
    return;
  }

  if (!status.haveToken) {
    tokenEl.append(el("div", null, "Ingen token fångad."), el("div", "muted", status.hint));
    probeBtn.disabled = true;
    return;
  }

  probeBtn.disabled = false;

  tokenEl.append(
    row("Källa", status.source === "webRequest" ? "portalens anrop" : "sessionStorage"),
    row("Målgrupp (aud)", status.aud),
    row("Inloggad som", status.upn ?? "—"),
    row("Klient (app)", status.appName ?? status.appId ?? "—"),
    row("Tenant", status.tenant ?? "—"),
    row("Giltig i", minutes(status.secondsLeft)),
    row("Antal scopes", String(status.scopes.length))
  );

  tokenEl.append(el("div", "sub", "Grupp-scopes:"), pills(GROUP_SCOPES, status.groupScopes));
  tokenEl.append(el("div", "sub", "Intune-scopes:"), pills(INTUNE_SCOPES, status.intuneScopes));
}

function renderProbe(report) {
  resultsEl.replaceChildren();
  if (!report || !report.results.length) return;

  const ok = report.verdict === "godkänt";
  resultsEl.append(
    el(
      "div",
      `verdict ${ok ? "ok" : "bad"}`,
      ok
        ? "Godkänt — token-lånet räcker för att bygga trädet."
        : "Underkänt — se vad som fallerar nedan."
    )
  );

  for (const r of report.results) {
    const probe = el("div", "probe");
    const mark = r.ok ? "✓" : r.required ? "✗" : "!";
    const tone = r.ok ? "ok" : r.required ? "bad" : "warn";

    const body = el("div", "body");
    body.append(el("div", null, r.label + (r.required ? "" : " (valfri)")));

    if (r.ok) {
      body.append(el("div", "why", `HTTP ${r.status} · ${r.count} post(er)`));
    } else {
      body.append(el("div", "why", r.skipped ? r.error : `HTTP ${r.status} · ${r.error}`));
    }

    probe.append(el("div", `mark ${tone}`, mark), body);
    resultsEl.append(probe);
  }
}

async function refresh() {
  renderStatus(await send({ type: "status" }));
}

refreshBtn.addEventListener("click", refresh);

probeBtn.addEventListener("click", async () => {
  probeBtn.disabled = true;
  probeBtn.textContent = "Kör …";
  const report = await send({ type: "probe" });
  renderStatus(report?.status);
  renderProbe(report);
  probeBtn.textContent = "Kör testanrop";
  probeBtn.disabled = false;
});

refresh();
setInterval(refresh, 10_000);
