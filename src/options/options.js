const fields = {
  prefix: document.getElementById("prefix"),
  showLoose: document.getElementById("showLoose"),
  onlyWithAssignments: document.getElementById("onlyWithAssignments"),
  healthCheck: document.getElementById("healthCheck"),
  demo: document.getElementById("demo"),
  consent: document.getElementById("consent")
};

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
  fields.healthCheck.checked = Boolean(settings.healthCheck);
  fields.demo.checked = Boolean(settings.demo);
  fields.consent.checked = Boolean(settings.consent);
})();

saveBtn.addEventListener("click", async () => {
  saveBtn.disabled = true;

  await send({
    type: "save-settings",
    patch: {
      prefix: fields.prefix.value,
      showLoose: fields.showLoose.checked,
      onlyWithAssignments: fields.onlyWithAssignments.checked,
      healthCheck: fields.healthCheck.checked,
      demo: fields.demo.checked,
      consent: fields.consent.checked
    }
  });

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
