---
name: OFFGRID
description: A map you can keep.
colors:
  paper: "#f5f4ed"
  surface: "#fcfcf8"
  ink: "#24352b"
  muted: "#657063"
  line: "#ddded3"
  green: "#254e3d"
  green-dark: "#163b2b"
  green-wash: "#e8eddf"
  lime: "#dce9b6"
  amber: "#82580e"
  danger: "#a1392c"
  focus: "#37684c"
  map-ground: "#ecece2"
  coverage-fill: "#e2e9d9"
  coverage-boundary: "#41684c"
  row-selected: "#e6ecd9"
  row-selected-border: "#cad6b8"
  primary-text: "#f8fbf2"
typography:
  display:
    fontFamily: "DM Sans Variable, Noto Sans Devanagari, system-ui, sans-serif"
    fontSize: "36px"
    fontWeight: 600
    lineHeight: 1.12
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "DM Sans Variable, Noto Sans Devanagari, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 550
    lineHeight: 1.2
    letterSpacing: "-0.035em"
  title:
    fontFamily: "DM Sans Variable, Noto Sans Devanagari, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 550
    lineHeight: 1.5
    letterSpacing: "-0.02em"
  body:
    fontFamily: "DM Sans Variable, Noto Sans Devanagari, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "DM Sans Variable, Noto Sans Devanagari, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 550
    lineHeight: 1.5
  map-label:
    fontFamily: "DM Sans Variable, Noto Sans Devanagari, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
rounded:
  compact: "5px"
  control: "6px"
  row: "8px"
  map: "9px"
  emblem: "11px"
spacing:
  tight: "4px"
  small: "8px"
  control: "12px"
  group: "16px"
  phone-gutter: "20px"
  section: "24px"
  wide: "28px"
  page: "48px"
components:
  button-primary:
    backgroundColor: "{colors.green}"
    textColor: "{colors.primary-text}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 18px"
    height: "48px"
  button-primary-hover:
    backgroundColor: "{colors.green-dark}"
  button-install:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "40px"
  button-location:
    backgroundColor: "transparent"
    textColor: "{colors.green}"
    padding: "10px 0"
  button-remove:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    height: "48px"
    width: "45px"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "#fff8f4"
    rounded: "{rounded.compact}"
    padding: "12px 16px"
  search-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "45px"
  library-navigation:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    padding: "12px 0"
  state-chip:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.compact}"
    padding: "7px 10px"
  state-chip-ready:
    backgroundColor: "{colors.green-wash}"
    textColor: "{colors.green}"
  area-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.row}"
    padding: "13px 10px"
  area-row-selected:
    backgroundColor: "{colors.row-selected}"
  coverage-map:
    backgroundColor: "{colors.map-ground}"
    rounded: "{rounded.map}"
    height: "clamp(330px, 43vh, 510px)"
---

# Design System: OFFGRID

## Overview

**Creative North Star: "A map you can keep."**

OFFGRID is a daylight map utility: mineral paper, forest green, quiet rules, and a real geographic drawing. The interface feels calm, practical, and ready to carry. Its visual weight belongs to coverage; region selection and download controls support that view with compact, factual information.

The system uses one self-hosted sans family, restrained tonal surfaces, and gently curved controls. Status comes from actual local-file and download state. Readiness, connection, and geographic coverage remain distinct ideas in both language and presentation.

**Key Characteristics:**

- Daylight paper and forest green.
- Actual vector coverage with a visible boundary and text equivalent.
- Selected list rows and horizontal rules rather than nested cards.
- Plain language, visible recovery actions, and private optional location.
- Phone controls that grow while the information stays compact.

This capture refreshes the provisional document from `apps/web/src/styles.css`, `App.tsx`, `AreaMap.tsx`, and the finished desktop/phone captures in `.impeccable/review/`. CSS remains the implementation source. There was no incumbent visual world or approved image composition. The Impeccable engine was unavailable; this document and its schema-version-2 sidecar follow the bundled document workflow, but engine schema validation, detector checks, and live-panel rendering could not be confirmed.

## Colors

Warm, lightly green neutrals keep the map legible; forest green carries action, selection, and verified local state.

### Primary

- **Forest Green** (`green`): primary actions, active navigation, location control, and the wordmark symbol.
- **Deep Forest** (`green-dark`): primary-action hover and strong text against a light selection.
- **Leaf Wash** (`green-wash`): location feedback, installation help, and verified-state surfaces.
- **Light Lime** (`lime`): text selection, paired with deep forest text.
- **Focus Green** (`focus`): visible keyboard outlines.
- **Selected Sage** (`row-selected`, `row-selected-border`): the current region receives a tonal fill and a defined outline.
- **Boundary Green** (`coverage-boundary`) and **Coverage Sage** (`coverage-fill`): exact coverage outline, corner markers, key, and map interior.

### Secondary

- **Recovery Amber** (`amber`): offline connection and actionable storage/connectivity notices.
- **Repair Red** (`danger`): destructive removal affordances. Errors also use a pale warm surface with dark red text.

### Neutral

- **Mineral Paper** (`paper`): page canvas.
- **Light Paper** (`surface`): search, map overlays, and control surfaces.
- **Forest Ink** (`ink`): headings and main text.
- **Soft Olive Ink** (`muted`): supporting text and inactive controls.
- **Paper Rule** (`line`): dividers and section boundaries.
- **Map Ground** (`map-ground`): the subdued geographic canvas.
- **Action Paper** (`primary-text`): primary button labels.

**The State Has Words Rule.** Pair status color with a label or icon and text; an online indicator never establishes that a map is saved.

## Typography

**Display and Body Font:** self-hosted DM Sans Variable, bundled through `@fontsource-variable/dm-sans`. The fallback stack is Noto Sans Devanagari, system UI, then sans serif; Noto is a fallback declaration, not a bundled font.

The family is direct and gently rounded, with tight headings and open supporting copy. Variable weights create hierarchy without a second display face. Sizes, coordinates, progress, and storage figures use tabular numerals where implemented.

### Hierarchy

- **Display:** the library heading; the frontmatter records its desktop role. It becomes (30px) on phones, retaining its weight and line height.
- **Headline:** selected-area heading; becomes (27px) on phones and (24px) at the smallest breakpoint.
- **Title:** download-section heading; becomes (17px) on phones and (16px) below the smallest breakpoint.
- **Body:** the root default. Most supporting interface copy is (11–13px); introductory helper copy has a generous line height (1.7).
- **Label:** buttons and progress labels. The primary action becomes (13px) on phones; the search field becomes (16px).
- **Map label:** the actual SVG renderer compensates for viewBox scale to preserve a readable display size (12px) at the base map view. It suppresses colliding and out-of-bounds labels. Thumbnails omit labels. Zoom magnifies the map and its labels together.

**The Readable Geography Rule.** Preserve display-sized map labels and collision suppression when the map resizes; reducing label text to fit is not the implemented solution.

## Layout

The desktop shell is centered with a maximum width (1720px). A ruled header (88px high) sits above a two-column workspace: the region library (338px) beside a flexible map workspace. Main gutters are (48px) at the header and (42px) around the map workspace. The sidebar owns selection, search, and local storage; the right side owns the selected area's title, coverage, facts, and action.

At widths of (1450px) and above, the library expands to (370px) and the map workspace uses (56px) side padding. At (1150px) and below, the library contracts to (300px), the fact grid becomes two columns, and action assurance wraps below the button. The desktop map uses the frontmatter height with a minimum (330px).

At (760px) and below, the header becomes (72px) and page gutters become (20px). The workspace follows a single document flow: library heading, tabs, search, optional location and its feedback, horizontally scrollable area choices, starter-area note, then the selected area's map and download details. Region rows are (248px) wide and use proximity scroll snapping. The map precedes the download action and is (310px) tall. Primary actions grow to (52px) high; search, location, and library tabs have (48px) targets; map buttons become (44px) square. The storage summary is hidden while saved status remains on the rows and selected area.

At (380px) and below, supporting header and map-coordinate text recedes to retain space. The coverage key stays bounded. There is no fixed bottom action bar. Four-column pack facts on wide screens become a two-by-two grid at narrower widths. Repeated spacing uses the observed scale in the frontmatter; there is no separate CSS spacing-variable system.

## Elevation & Depth

The page is flat at rest. Rules, tonal fills, and the map's own drawing separate regions. Small shadows lift controls over geographic detail; the primary action gains a restrained shadow on hover. Content sections do not become floating cards.

### Shadow Vocabulary

- **Map overlay:** `0 6px 20px rgb(35 48 35 / 8%)`, used by the coverage caption, coverage key, and zoom controls.
- **Action hover:** `0 4px 12px rgb(27 62 41 / 12%)`, used by the primary button on hover; disabled state removes it.

**The Map Overlay Rule.** Use elevation to keep map controls readable over streets; use rules and tonal selection for the rest of the workspace.

## Shapes

Compact labels and map keys use the compact radius; search and buttons use the control radius; region rows use the row radius. The map clips its contents at the map radius, reduced to (7px) on phones. Icon emblems have a slightly softer silhouette (10–12px). One-pixel borders and quiet horizontal rules carry most separation.

The geographic boundary is dashed, with square corner markers; its legend repeats the same fill and stroke. The optional location marker is a blue dot with a white edge and translucent halo. Small circular indicators and the brand's green full stop are accents, not container shapes. Lucide outline icons share the page's restrained stroke treatment.

## Components

### Buttons

Primary download, pause, resume, update-download, and local-check actions share the forest fill, light label, control radius, and frontmatter sizing. The desktop minimum width is (270px); on phones the action flexes to available width. A download size can occupy a ruled trailing segment. Disabled downloads use a muted sage surface and no hover shadow.

The install/update-app button is a compact outlined secondary action. Location and ordinary text actions are green, unfilled, and underline on hover. The remove icon is outlined and becomes red on hover; its inline confirmation exposes a red destructive button and a Keep map action. Removal is never performed by the first icon press.

All interactive controls retain the global visible keyboard ring (3px with a 4px offset). Primary background and shadow transitions last (160ms). The map zoom transition lasts (240ms) with `cubic-bezier(.16,1,.3,1)`. Location lookup can spin and verification can pulse; both use (1.5s) cycles. Reduced-motion preferences remove these transitions and animations while retaining state text.

### Inputs / Fields

The search field is a light-paper outlined container with a leading search icon, explicit accessible label, and a conditional clear button. Desktop text is compact (12px); phone text grows to (16px). Focus is shown around the complete field (2px outline, 2px offset), rather than around the unbordered inner input. Search filters region names, subtitles, and coverage labels; an empty result shows a text explanation.

### Navigation

Explore areas and Downloaded are inline button controls with pressed state, separated from content by a fine rule. The active item uses forest text, heavier weight, and an underline (2px); the downloaded count sits in a small neutral badge. Phone tabs grow to (13px) and a (48px) minimum target. A skip link becomes visible on keyboard focus.

### Region Rows / Containers

Each region is a button with a real compact vector preview, name, subtitle, size/coverage or saved/resume text, and a trailing chevron. Selection uses Selected Sage fill, border, and `aria-pressed`. Hover uses a light olive fill. Desktop rows form a vertical list; phones use a horizontal strip. This row pattern supplies the selection surface without a general-purpose card grid.

### Status Chips and Feedback

The selected-area chip distinguishes coverage preview from saved on this device. Saved styling combines green wash, a defined border, a check icon, and words. The preview chip may hide at intermediate widths; saved status remains visible. Header connectivity has its own icon and label.

Location feedback appears immediately below Use my location and is linked with `aria-describedby`; lookup is requested only by that control. Success, permission denial, unsupported location, and out-of-coverage results remain at that point in the flow. Download errors use alerts; verification and installation notices use status messages near the action. Dismissal controls have accessible names. Storage-persistence and offline-download notices use amber text with an explanatory action or next step.

### Coverage Map

The signature surface renders the catalogue's vector streets, paths, and exact rectangular pack bounds. Road casings, subdued road hierarchy, pale coverage fill, dashed edge, corner markers, and collision-aware text establish geography without remote tiles. The preview identifies itself as download coverage; a verified installed drawing identifies itself as the offline map. Compact list previews omit minor paths and labels.

The caption sits at the upper left, compass at the upper right, coverage key at the lower left, zoom/reset controls at the lower right, and attribution in a ruled footer. Zoom ranges from (1×) to (2.5×) in (0.25×) steps and resets to the full boundary. The SVG has an accessible description, while area facts provide a text equivalent for coverage. Optional private location appears only within the selected bounds.

### Download Details and Real States

The facts preserve actual bytes, bounded area, source date, and included content before a download. Available, downloading, paused/interrupted, verifying, verified-installed, failed, and removed states share the same section. Progress combines a bar, percentage, and byte counts. Pausing or interruption offers Resume download; a saved pack offers Check offline files and removal. Updates keep a prior verified installation available until the replacement verifies.

Saved means the local files passed verification, including after reopening. The downloaded view can also show interrupted work for recovery, but its count reflects verified installations. Offline state disables a new download and explains the need for connectivity while saved maps remain usable. Installation instructions and app updates are separate from map readiness. Empty library and unpublished-catalogue states use direct next-step text.

## Do's and Don'ts

### Do:

- **Do** preserve the daylight paper, forest action color, restrained rules, and real geographic drawing.
- **Do** show exact coverage, actual download size, and source date before download.
- **Do** keep location feedback beside the initiating control and request location only after that control is pressed.
- **Do** pair every progress, offline, saved, and recovery state with text.
- **Do** preserve display-sized map labels, collision suppression, visible focus, and reduced-motion behavior.
- **Do** distinguish verified local map files from connectivity and app installation.

### Don't:

- **Don't** present starter coverage as a full-city map or imply a place is guaranteed safe.
- **Don't** replace the actual coverage map with decorative map imagery or synthetic city claims.
- **Don't** use an online indicator or completed animation as proof of offline readiness.
- **Don't** bury recovery guidance away from the control or download state it explains.
- **Don't** replace selected rows and quiet rules with layers of elevated cards.
- **Don't** introduce remote font or map-style dependencies into the offline preparation interface.


## Android walking surface ? 4 November 2026

The existing paper/forest-green world extends to the Capacitor Android pilot and web companion. Navigation uses a top app bar with Back, an interactive local street map, and an adjacent planner on wide screens. Phone layout places the map above a sheet; active guidance collapses endpoint/summary editing so instruction and Pause are visible beside the map. Guidance is foreground-only.

Map gestures support drag/pinch, pointer cancellation, inertia and visible zoom/reset controls. An accepted route fits with local context; labels stay readable and avoid collisions. Coverage and navigation maps use MapLibre's tiled WebGL renderer, with camera gestures outside React and geometry simplified in a local worker. Compact catalogue thumbnails retain bounded SVG previews. Styles, workers, fonts and map data remain local. Start/end pins, current position and the route have distinct marks. Named-place controls provide a keyboard alternative to map taps.

Endpoint activation enters edit mode and focuses place search. Planning success focuses the route heading; active guidance has an explicit focus target and instruction announcements. Permission/out-of-area/accuracy feedback appears beside the location action. Errors, interruption, retry, ambiguous paths and bounds failures are stated plainly. Native map actions say Save because this pilot bundles published packs.

Browser captures and actual Samsung library/navigation screenshots have been inspected. Samsung drag/pinch, offline routing, saved files, recovery and Back are verified; the WebGL drag comparison reached 16.7-ms median intervals in the recorded runs. TalkBack, large fonts, rotation, other devices and physical walking still require acceptance. Native evidence comes from the phone; browser captures are not relabelled as Android screenshots.
