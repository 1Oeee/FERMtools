// Kör testerna och ritar resultatet.
//
// Egen fil och inte ett inline-script: tilläggets sidor har en CSP som
// stoppar inline-skript, och då stod testsidan på "Kör …" för alltid när den
// öppnades från inställningarna.

import { runAll } from "./tree.test.js";
// Importeras för sina biverkningar: filen registrerar sina tester i
// samma ram när den laddas.
import "./theme.test.js";
import "./tenant.test.js";

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
    ? `Alla ${total} tester gröna.`
    : `${total - passed} av ${total} tester föll.`;
