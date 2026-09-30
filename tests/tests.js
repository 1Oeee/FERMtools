// Testsidans körare. Egen fil, inte ett inline-skript: tillägg får inte köra
// inline-skript (MV3:s Content Security Policy), och då stod sidan kvar på
// "Running …" när den öppnades från inställningarna.

import { runAll } from "./tree.test.js";
// Importeras för sina biverkningar: filen registrerar sina tester i
// samma ram när den laddas.
import "./theme.test.js";
import "./demo.test.js";
import "./health.test.js";
import "./msal.test.js";
import "./score.test.js";
import "./devices.test.js";
import "./platforms.test.js";
import "./warehouse.test.js";
import "./xlsx.test.js";

const list = document.getElementById("list");
const summary = document.getElementById("summary");

function report({ name, ok, error }) {
  const row = document.createElement("div");
  row.className = `t ${ok ? "ok" : "bad"}`;

  const mark = document.createElement("div");
  mark.className = "m";
  mark.textContent = ok ? "✓" : "✗";

  const body = document.createElement("div");
  body.append(Object.assign(document.createElement("div"), { textContent: name }));
  if (!ok) {
    body.append(
      Object.assign(document.createElement("div"), {
        className: "why",
        textContent: error
      })
    );
  }

  row.append(mark, body);
  list.append(row);
}

const { passed, total } = await runAll(report);
summary.className = passed === total ? "ok" : "bad";
summary.textContent =
  passed === total
    ? `All ${total} tests green.`
    : `${total - passed} of ${total} tests failed.`;
