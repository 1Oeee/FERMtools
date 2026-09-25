// Samma tester som tests.html, fast i Node — så att GitHub Actions kan köra
// dem före varje paketbygge. `node tests/run.mjs`
//
// theme.js läser sin adress vid import. Det är den enda webbläsardel testerna
// når, och en tom tilläggsadress räcker för den.

globalThis.location = new URL("chrome-extension://test/tests/tests.html");

const { runAll } = await import("./tree.test.js");
await import("./theme.test.js");
await import("./demo.test.js");
await import("./health.test.js");
await import("./msal.test.js");

const { passed, total } = await runAll(({ name, ok, error }) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n    ${error}`}`);
});

console.log(`\n${passed} av ${total} gröna.`);
process.exit(passed === total ? 0 : 1);
