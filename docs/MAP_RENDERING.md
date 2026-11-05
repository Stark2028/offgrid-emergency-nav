# Map interaction performance

The SVG renderer in 0.2.0-preview was inadequate for city-scale touch interaction. It grouped roads into a few DOM paths, but changing the viewBox still repainted the complete geometry and each pointer movement rerendered the React map, recomputed visible labels and updated the SVG overlay. Prayagraj contains about 20,000 roads / 187,000 drawing points. Low DOM node count did not establish smooth rendering.

## Preview 0.2.1

The coverage preview and walking map now use MapLibre GL JS 6.16.0. Its local worker indexes/tiles the saved GeoJSON and simplifies drawing geometry by zoom; WebGL draws visible tiles. Camera gestures, pinch zoom and inertia run in the map engine without React state updates for each movement. Minor streets and walking paths gain detail as the user zooms in. Route calculations and verified source data are unchanged by this rendering simplification.

The style is app-owned and uses the existing paper/forest palette. Streets, route, position, place labels, style, renderer worker and fonts come from bundled/saved assets. No demo tile URL, API key, remote glyph server or Google service is used. The web service worker includes the renderer worker and local font/license assets. Compact area-list thumbnails retain bounded SVG drawings.

Pixel ratio is capped at 2, the tile cache at 48 and worker count at 2. Maps are removed on unmount. Rotation/pitch are disabled; keyboard navigation, zoom/reset controls and named-place selection remain available. Renderer failure/context loss has a visible recovery action. WebGL device compatibility, memory and battery on lower-end phones remain acceptance work; these limits are not a universal performance guarantee.

## Measurement

`apps/web/tools/profile-map.mjs` measures three runs of four 600-ms Android touch swipes. It requires an explicitly selected phone, an unlocked screen and the debug app in the foreground. It reads no GPS position and takes no screenshots. It verifies OFFGRID remains foreground before every swipe. Frame intervals are collected through requestAnimationFrame; long tasks and map DOM mutations are also recorded. ADB command gaps are included, so this is a comparative diagnostic, not an isolated GPU benchmark or continuous-drag FPS certification.

On Samsung Galaxy M53 / Android 15, the original renderer had median frame intervals of **100.0, 83.5 and 35.5 ms**, with 95th percentiles of **216.6, 200.2 and 200.1 ms**. The SVG camera was at 1.5^5 magnification; the WebGL comparison uses 2^3 (5.3% closer). Raw local reports live in ignored `.impeccable/review/samsung-map-profile-*.json`.

The updated-device comparison completed on **5 November 2026, India time**, after the user unlocked the phone. The screen was awake and OFFGRID was foreground. All three WebGL runs had median frame intervals of **16.7 ms** and p95 intervals of **16.8 ms**. Across 557 sampled intervals, none exceeded 25 ms; the maximum was 17.3 ms. No long task was observed during the measured swipes. Map DOM mutations fell from 608/566/480 to 3/4/5 across the respective runs. This establishes a substantial improvement in this phone's measured interaction cadence, not a guarantee for every device or cold tile load.

| Diagnostic | Original SVG | Updated WebGL |
| --- | --- | --- |
| Median interval across the three runs | 100.0 / 83.5 / 35.5 ms | 16.7 / 16.7 / 16.7 ms |
| P95 interval across the three runs | 216.6 / 200.2 / 200.1 ms | 16.8 / 16.8 / 16.8 ms |
| Sampled intervals over 25 ms | 76 of 123 | 0 of 557 |

```powershell
$env:OFFGRID_ADB_SERIAL='DEVICE_SERIAL'
$env:ANDROID_HOME='C:/path/to/Android/Sdk'
$env:OFFGRID_PROFILE_NAME='webgl-after'
node apps/web/tools/profile-map.mjs
```

All 12 browser scenarios passed with the new renderer, including offline reload and worker route calculation. Subsequent desktop/mobile drag regressions passed: a drag moves the marker without changing the selected start; resetting the camera still permits graph-point selection and offline routes. Debug and optimized Android APKs build and lint passes. The updated physical-phone run passed eight app checks, including real two-touch pinch input, offline routing, file checking, force-stop recovery and Back. The optimized test copy passed five accessibility-driven checks with WebView debugging disabled and is left installed. See [the 5 November device record](DEVICE_TEST_2026-11-05.md).

Sources: [MapLibre architecture](https://github.com/maplibre/maplibre-gl-js/blob/main/ARCHITECTURE.md), [bundled Vite worker setup](https://maplibre.org/maplibre-gl-js/docs/), [local-font labels](https://maplibre.org/maplibre-gl-js/docs/examples/style-labels-with-local-fonts/). The package's redistribution notices are bundled in `apps/web/public/licenses/MapLibre-GL-JS.txt`.
