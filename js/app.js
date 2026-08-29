/* ===========================================================================
   nyx.despotak.is — page behaviour

   Deliberately small. The disclosure widgets are <details>, so the doctrine
   reads and expands with scripting off; this file only does the two things
   CSS genuinely cannot: decide whether to boot a GPU simulation at all, and
   stop paying for it once it has scrolled away.
   ========================================================================= */
"use strict";

(() => {
  const canvas = document.getElementById("c");
  if (!canvas) return;

  const stillPreferred = matchMedia("(prefers-reduced-motion: reduce)");

  /* ---------------------------------------------------------------------
     Reduced motion is a request, not a hint. Nine fragment-shader passes a
     frame is exactly the kind of thing it is asking about, so we do not
     boot the solver at all — the stylesheet already replaces it with a
     static wash. Nothing is downloaded either, since the module is only
     ever injected here.
     ------------------------------------------------------------------- */
  if (stillPreferred.matches) {
    canvas.remove();
    return;
  }

  const script = document.createElement("script");
  script.src = "js/night.js";
  script.defer = true;

  script.addEventListener("load", () => {
    const night = window.nyxNight;
    if (!night) return;                       // solver bailed; CSS shows the wash

    /* -------------------------------------------------------------------
       The sky is a band at the top of the document and scrolls away on its
       own, so visibility is CSS's problem. What is left is the GPU: nine
       fragment-shader passes a frame is not something to keep paying for
       while it renders to pixels nobody can see.
       ----------------------------------------------------------------- */
    const sky = document.querySelector(".sky");
    if (sky && "IntersectionObserver" in window) {
      new IntersectionObserver(
        ([entry]) => (entry.isIntersecting ? night.resume() : night.pause()),
        { rootMargin: "128px" }
      ).observe(sky);
    }
  });

  script.addEventListener("error", () => canvas.remove());
  document.head.append(script);

  /* If the preference flips mid-session, honour it immediately. */
  stillPreferred.addEventListener("change", (e) => {
    if (!e.matches) return;
    window.nyxNight?.pause();
    canvas.remove();
  });
})();

/* -------------------------------------------------------------------------
   Deep links into a single rule. `#doctrine` scrolls to the section; a rule's
   own id opens it, so a link can point at the exact incident it is citing.
   ---------------------------------------------------------------------- */
(() => {
  const rules = document.querySelectorAll(".rule");
  rules.forEach((rule, i) => {
    const id = `rule-${String(i + 1).padStart(2, "0")}`;
    rule.id = id;
    const summary = rule.querySelector("summary");
    if (summary) summary.title = `Permalink: #${id}`;
  });

  const openFromHash = () => {
    const target = document.querySelector(
      location.hash && /^#rule-\d\d$/.test(location.hash) ? location.hash : "#\\0"
    );
    if (target) target.open = true;
  };
  addEventListener("hashchange", openFromHash);
  openFromHash();
})();
