# Site versions

Archived snapshots of `index.html`, kept so each positioning pass can be compared or restored. The live page is always the root `index.html`.

| File | Date | What it is |
|---|---|---|
| `v0-original-architect.html` | 30 Oct 2026 | Original site: architect positioning, Literata serif, light palette. |
| `v1-leadership-copy.html` | 8 Nov 2026 | Copy repositioned for AI leadership roles: governance area, Value position, C-suite section, scope-based timeline. Same design as v0. |
| `v2-editorial-redesign.html` | 8 Nov 2026 | Visual redesign on v1 copy: DM Sans body, green palette, dark graph panel, career strip, numbered positions, collapsed nav. |
| `v3-executive-copy.html` | 8 Nov 2026 | Executive copy pass on v2: generalized language, collapsible "Technical foundations" under each capability. |
| `v4-hybrid.html` | 8 Nov 2026 | Recommended. v2 design, v1 concrete copy trimmed for an executive reader, v3 collapsible stacks, larger type, Experience restored to nav, mobile grid tracks set to minmax(0,1fr). |
| `v5-infographics.html` | 8 Nov 2026 | v4 plus: headline "concept to pilot to production" at a smaller size; looping animated knowledge-graph panel; new "Selected work" section with a knowledge-layer flow diagram and the AWARE evidence trail; six-step concept-to-production gate in "How I lead"; layered career strata above the timeline. All reveal on scroll and respect reduced motion. |
| `v6-physician-flow.html` | 8 Nov 2026 | Knowledge-layer diagram redrawn as the physician-question flow: normalize, expand via graph, deterministic FHIR query and note search in parallel, fuse, generate and check citations, answer with the path. Seven numbered, quoted sources beneath. Smaller three-line hero headline with ochre arrows. |
| `v7-ventures.html` | 9 Nov 2026 | v6 plus a "Ventures" section between Writing and Path, with a nav link. First entry: Hybrid VFX USA, linking to the full case study at `ventures/hybrid-vfx-usa.html`. "Evidence" nav link hidden between 861 and 1000 px so eight links fit. |
| `v8-tools.html` | 10 Nov 2026 | v7 plus a "Tools" section between Ventures and Path, with a nav link. First entry: pdfEditor, a browser-only PDF editor served from `tools/pdfEditor/` (PDF.js and pdf-lib vendored, no build step). "Evidence" nav link now hidden between 861 and 1100 px and at 540 px and below, "Approach" between 861 and 920 px, so the links fit. |

Each version is also a git tag (`v0` to `v8`) on the commit where it was the live `index.html`.
