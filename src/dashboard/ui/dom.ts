// Small DOM helpers so views build markup with typed calls instead of
// string concatenation. Memory text is arbitrary user content (it may embed
// markup, and the store may itself hold a user's own secrets) -- everything
// here goes through createElement/textContent/setAttribute, never
// innerHTML, so nothing from the API is ever parsed as HTML.

// The daemon serves this dashboard with a strict CSP (`style-src 'self'`, no
// 'unsafe-inline'), so a `style="..."` attribute is parsed and silently dropped --
// no error, just a broken layout. Ban `style` here at the type level so that
// mistake is a compile error instead of a runtime trap; set `.style.<prop>` on
// the element `el()` returns instead.
type Attrs = Record<string, string | boolean | undefined> & { style?: never };
type Child = Node | string | null | undefined;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  children?: Child[],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === false) continue;
      if (value === true) {
        node.setAttribute(key, "");
      } else {
        node.setAttribute(key, value);
      }
    }
  }
  if (children) {
    for (const child of children) {
      if (child === null || child === undefined) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
  }
  return node;
}

export function text(value: string): Text {
  return document.createTextNode(value);
}

export function clear(node: Element): void {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

// A minimal inline SVG icon (author the path data by hand -- no icon
// package). `title` becomes a real <title> element so the icon carries its
// own accessible name even where the caller cannot also set aria-label
// (e.g. an icon placed inside an already-labeled button).
export function icon(pathD: string, title?: string): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("focusable", "false");
  if (title) {
    const titleEl = document.createElementNS(ns, "title");
    titleEl.textContent = title;
    svg.appendChild(titleEl);
  } else {
    svg.setAttribute("aria-hidden", "true");
  }
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", pathD);
  path.setAttribute("fill", "currentColor");
  svg.appendChild(path);
  return svg;
}
