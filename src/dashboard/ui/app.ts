// Browser entrypoint: loaded by index.html as an ES module (tsc emits this
// file as-is, no bundler). It must not import from node:* or from src/,
// since it never runs in Node.
//
// The repo's tsconfig deliberately has no "dom" lib (the rest of the repo
// is Node-only), so DOM types are not available here. Declare only the
// tiny surface this placeholder touches; a later step grows this as the
// real SPA needs more of the DOM.
declare const document: {
  getElementById(id: string): { textContent: string } | null;
};

const app = document.getElementById("app");
if (app) {
  app.textContent = "Cairn dashboard is loading...";
}

export {};
