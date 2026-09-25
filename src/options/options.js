const fields = {
  prefix: document.getElementById("prefix"),
  showLoose: document.getElementById("showLoose"),
  onlyWithAssignments: document.getElementById("onlyWithAssignments"),
  demo: document.getElementById("demo"),
  consent: document.getElementById("consent"),
  msalClientId: document.getElementById("msalClientId"),
  msalTenant: document.getElementById("msalTenant")
};

const modes = {
  portal: document.getElementById("modePortal"),
  msal: document.getElementById("modeMsal")
};
const portalFields = document.getElementById("portalFields");
const msalFields = document.getElementById("msalFields");
const signInBtn = document.getElementById("signIn");
const signOutBtn = document.getElementById("signOut");
const account = document.getElementById("account");

/** Inställningar som en policy låser. Sparas inte som användarens egna. */
let managed = [];

const selectedMode = () => (modes.msal.checked ? "msal" : "portal");

function showMode() {
  const msal = selectedMode() === "msal";
  msalFields.hidden = !msal;
  portalFields.hidden = msal;
}
for (const radio of Object.values(modes)) radio.addEventListener("change", showMode);

function showAccount(status) {
  if (status?.authMode !== "msal") {
    account.textContent = "";
    return;
  }
  account.textContent = status.signedIn
    ? `Signed in as ${status.upn ?? "your account"}.`
    : status.lastError
      ? `Not signed in: ${status.lastError}`
      : "Not signed in.";
  signOutBtn.disabled = !status.signedIn;
}

const saveBtn = document.getElementById("save");
const saved = document.getElementById("saved");

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(chrome.runtime.lastError ? null : response);
    });
  });
}

(async () => {
  const settings = (await send({ type: "settings" })) ?? {};
  fields.prefix.value = settings.prefix ?? "";
  fields.showLoose.checked = Boolean(settings.showLoose);
  fields.onlyWithAssignments.checked = Boolean(settings.onlyWithAssignments);
  fields.demo.checked = Boolean(settings.demo);
  fields.consent.checked = Boolean(settings.consent);
  fields.msalClientId.value = settings.msalClientId ?? "";
  fields.msalTenant.value = settings.msalTenant ?? "organizations";
  (settings.authMode === "msal" ? modes.msal : modes.portal).checked = true;
  document.getElementById("redirectUri").textContent = settings.redirectUri ?? "";

  // Det en policy har låst går inte att ändra här.
  managed = settings.managed ?? [];
  if (managed.includes("authMode")) for (const radio of Object.values(modes)) radio.disabled = true;
  if (managed.includes("msalClientId")) fields.msalClientId.disabled = true;
  if (managed.includes("msalTenant")) fields.msalTenant.disabled = true;
  document.getElementById("managedNote").hidden = !managed.length;

  showMode();
  showAccount(await send({ type: "status" }));
})();

signInBtn.addEventListener("click", async () => {
  signInBtn.disabled = true;
  // Det som står i fälten ska gälla — spara först.
  await save();
  const response = await send({ type: "sign-in" });
  signInBtn.disabled = false;
  showAccount(response?.status);
  if (!response?.ok) account.textContent = response?.error ?? "Sign-in failed.";
});

signOutBtn.addEventListener("click", async () => {
  const response = await send({ type: "sign-out" });
  showAccount(response?.status);
});

function save() {
  const patch = {
    prefix: fields.prefix.value,
    showLoose: fields.showLoose.checked,
    onlyWithAssignments: fields.onlyWithAssignments.checked,
    demo: fields.demo.checked,
    consent: fields.consent.checked,
    authMode: selectedMode(),
    msalClientId: fields.msalClientId.value.trim(),
    msalTenant: fields.msalTenant.value.trim() || "organizations"
  };
  for (const key of managed) delete patch[key];
  return send({ type: "save-settings", patch });
}

saveBtn.addEventListener("click", async () => {
  saveBtn.disabled = true;

  await save();
  showAccount(await send({ type: "status" }));

  saveBtn.disabled = false;
  saved.hidden = false;
  setTimeout(() => {
    saved.hidden = true;
  }, 2000);
});

// The test page lives in the extension, so it has to be opened via its own URL.
const tests = document.getElementById("tests");
tests.href = chrome.runtime.getURL("tests/tests.html");
tests.target = "_blank";
