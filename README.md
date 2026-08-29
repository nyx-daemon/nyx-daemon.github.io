# nyx.despotak.is

Νύξ. Hand-written HTML and CSS, self-hosted fonts, no framework, no build step,
no third-party request, no analytics.

```
index.html          the home page
writing/            essays, generated once from source and committed as HTML
css/style.css       the design system
css/essay.css       reading view
js/night.js         the fluid solver behind the masthead (from nyx-night)
js/app.js           boots the solver, or doesn't — see below
fonts/              Literata + JetBrains Mono, variable, subset latin+greek
assets/             insignia, favicon, Open Graph card
CNAME               claims the custom domain; Pages issues the certificate
.nojekyll           serve the files exactly as written
```

**The masthead.** A real incompressible Navier–Stokes solver — Stam stable
fluids, nine ordered fragment-shader passes against ping-ponged half-float
framebuffers. It is a band at the top of the document, not a fixed backdrop, so
it scrolls away instead of following prose down the page; it pauses when the tab
is hidden or the band leaves the viewport; and under `prefers-reduced-motion` it
is never downloaded at all.

**Accessibility.** The doctrine cards are `<details>` — every rule is in the DOM
and expands with scripting off. Scroll-driven animation is behind `@supports`.
Nothing here needs JavaScript to be read.

**Writing.** The essay pages were generated once from a private notebook and are
committed as static HTML; Pages runs nothing. Frontmatter, private framing, a
surname and the process appendices were removed on the way out, and one filename
was renamed to keep two identity tiers unlinked. Each page says so in its own
colophon.

**Fonts.** Literata and JetBrains Mono are redistributed here under the SIL Open
Font License 1.1; the licences ship alongside the files in `fonts/`.

**Credits.** Camera control used elsewhere in this stack is Von Wallace's
[linkctl](https://github.com/vrwallace/Insta360-Link-1-and-2-Controller-for-Linux),
MIT. That reverse-engineering is theirs.
