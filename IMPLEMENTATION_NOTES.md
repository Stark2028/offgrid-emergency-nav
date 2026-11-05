# Android walking pilot ? 4 November 2026

Implementation branch: `feat/offline-map-setup`, in `OFFGRID/`. The parent Outage DNA project remains a different project. Device evidence was recorded before source publication; subsequent commits and pushes are tracked by Git history. No merge, deployment or production signing was performed.

## Map interaction update: 0.2.1-preview

The user reported jerky dragging/zooming. The physical Samsung SVG baseline had 95th-percentile frame intervals around 200-217 ms during repeated touch swipes. Coverage/navigation now use a bundled MapLibre 6.16.0 WebGL renderer: local worker tiling, zoom-dependent drawing detail, standard pan/pinch/inertia and no React state update per gesture. Compact list thumbnails remain bounded SVGs. Routes, pack hashes and native storage contracts are unchanged.

All 12 browser scenarios passed with the renderer; subsequent desktop/mobile drag regressions passed and full Prayagraj offline cases passed after the final camera adjustment. Dependency audit is clean. Debug, instrumentation APK and optimized release build/lint passed. Exported versionCode 2 APKs contain 1,086 verified current files; signatures and hashes were checked.

The physical follow-up completed on **5 November 2026, India time**. All three measured drag runs had median/p95 frame intervals of 16.7/16.8 ms, versus the original SVG p95 of 200-217 ms. None of 557 sampled intervals exceeded 25 ms. Eight updated-app checks passed, including actual two-touch pinch input, native storage/file verification, force-stop recovery, WebView-network-disabled routing and native Back. The optimized copy passed five accessibility-driven checks with WebView debugging disabled and is now installed, preserving the existing Prayagraj map. No GPS request or system-setting change was made in this follow-up. See [map rendering evidence](docs/MAP_RENDERING.md) and [the updated device record](docs/DEVICE_TEST_2026-11-05.md). Earlier physical results below describe the original 0.2.0-preview run.

## Implemented after the preparation milestone

- Capacitor 8 Android application (`org.offgrid.navigation`, API 24+, SDK 36), local HTTPS assets, minimum WebView 117, private SQLite storage and bounded native bridge chunks/batches. Native SHA-256 and transactional activation preserve a working generation through an interrupted replacement.
- Native foreground location, explicit permission initiation, stale/poor-accuracy/out-of-coverage handling, Back and system insets. Guidance pauses in the background; no foreground service or lock-screen guidance is claimed.
- Local place selection and map pins, pan/pinch/zoom, directed path-interior starts/destinations, worker routing, actual path geometry, approximate walking time, directions, progress, off-route feedback and manual recalculation.
- Bounded routing graph view prevents excursions outside download coverage. Ambiguous overlapping levels require a clearer point. Walking simplification preserves way boundaries so stairs/footway speed changes cannot be averaged into one edge.
- Conservative rejection of explicitly seasonal/temporary/pontoon/floating/ford and unevaluated conditional-access paths. Missing source tags still require ground validation.
- A frozen Prayagraj source snapshot (18,700,010 source bytes), 841.80 km? coverage, 9,878,890 published bytes, 1,002 graph tiles plus the basemap. Main-city and named Naini/Jhunsi/Phaphamau coverage are shown as a rectangle, not an official boundary.
- City drawing batches road classes into a few SVG paths instead of tens of thousands of DOM nodes; route fit, readable collision-filtered labels, accessible endpoint editing/focus and nearby location feedback are implemented. Download journals and leases avoid excessive writes; file integrity/activation checks remain mandatory.
- Native pilot packs are bundled and user-saved. Historical generations are retained in the web publication but omitted from the generated Android copy.
- Android CI compiles APKs/lint and is configured for SQLite instrumentation and emulator smoke. Its hosted execution has not been claimed. All five native SQLite instrumentation cases passed on a physical Samsung Galaxy M53 (Android 15).

## Evidence and limits

Core: 150 passing tests, four historical full-Delhi tests skipped because those tiles are absent. Map/navigation tests: 33 passing. Python pipeline: 181 passing. All four current packs hash/parse correctly; 240 real-OSM queries match independent reference Dijkstra. Desktop and Pixel browser acceptance: 12 passing; the four navigation cases were rerun after the physical-phone junction fix. Dependency audit is clean. Final APK sizes/hashes are recorded with the exported artifacts.

Native debug and optimized unsigned release builds have succeeded during implementation; exported artifacts are checked against the synced shell and current map files. Android lint is run without hiding errors. Local emulators failed before boot, so acceptance continued on the user's authorized physical Samsung Galaxy M53 (SM-M536B), Android 15 / API 35, Chrome WebView 153.0.8010.39.

On that phone, five native SQLite tests passed. Seven app checks passed: native bridge, saving Prayagraj, private database presence, force-stop recovery, full saved-file verification, routing with the app WebView network disabled, and Android Back. Actual Android screenshots were inspected. The phone's system network settings and personal data were not changed. Precise foreground location permission was granted by the user, but the location request returned no usable fix; actual GPS guidance, a familiar walk, lock-screen/lifecycle cases and reopening in real airplane mode remain unverified.

The original 0.2.0 optimized/R8 build, signed only for local testing with the existing debug identity, also passed five accessibility-driven checks on the phone: release WebView debugging disabled, saved-map preservation, native file verification, navigation opening and Back. It was subsequently replaced by the validated 0.2.1 optimized test copy described above. Exported optimized release candidates remain unsigned; these tests did not create a production identity. See [the original device test record](docs/DEVICE_TEST_2026-11-04.md) for its artifact hashes.

Phone testing found and repaired two product defects: Capacitor's `getLong` rejected small JSON integer offsets, preventing native map saves; explicit safe-integer decoding now handles integer/double JSON representations and rejects invalid values. A pin near a connected junction could be falsely rejected as overlapping paths; candidates now normalize to a shared graph endpoint within two metres. Unconnected overlapping levels remain rejected. Native instrumentation and a new navigation regression cover these failures.

An independent UI reviewer identified label scaling, endpoint editing, focus transitions, remote location feedback and below-fold guidance. These were fixed and checked with browser tests/captures. The reviewer's confirmation turn hit the service usage limit; the bounded confirmation was performed directly. Physical Samsung library/route screenshots were subsequently inspected; TalkBack, large-font and orientation acceptance remain open.

See [Android acceptance and release controls](docs/ANDROID_RELEASE.md) and [production gaps](PRODUCTION_READINESS.md).

---

## Archived preparation implementation ? 3 November 2026

# Map setup and routing fixes — 3 November 2026

Implemented locally on `feat/offline-map-setup`, based on the reviewed `fix/production-readiness` head `db930587788b3dcbc7b0135acec289567702d707`. The separate Outage DNA project in the parent folder was not modified.

## Delivered

- A responsive React map-preparation app: manual search, optional location, actual geographic previews, source dates, exact map-file sizes, downloaded-area management and removal confirmation.
- Three bounded, real OpenStreetMap starter packs: Connaught Place, Hauz Khas/Green Park and Noida Sector 18/Botanical Garden. The app explicitly states these are not full-city downloads.
- A catalogue/manifest contract with app-release-pinned SHA-256 hashes, immutable generation identities, source provenance and per-file integrity/structure checks.
- IndexedDB staging, persisted prefix resume, validated HTTP ranges, clean restart when needed, quota/error recovery, cross-tab writer leases, atomic installation and preservation of an old map during a failed update.
- A production offline shell with local fonts/icons, an installation prompt/help, explicit app-update acceptance, offline reopening and local saved-file re-verification.
- A conservative starter walking profile, immutable pack publisher, frozen source snapshots, attribution and dependency/font notices.

## Routing corrections

| Review issue | Implementation | Evidence |
| --- | --- | --- |
| A* loses a direct exact-bound path | Join against known finite opposite distances instead of requiring opposite settlement | Original two-node counterexample and independent oracle regression |
| Halo owner changes under Float32 rounding | Quantize before ownership decisions in the pipeline | Cross-language boundary test |
| Heuristic assumptions differ from shipped coordinates | Quantize graph nodes before cost calculation; reject tile edges whose endpoint lower bound exceeds weight | 40 generated precision graphs; 3,545 independently checked queries and consistency/path-cost assertions |
| Escape search lacks uncertainty/caps | Map-compatible `EscapeResult` reports coverage, missing cells, budgets and unknown exits; overlays enforce integer base–20× bounds | Partial escape fixture, invalid overlays, budget/unknown-exit regressions |
| Coincident consecutive IDs disconnect a way | Preserve a positive minimum-cost edge for distinct IDs; skip repeated identical-ID self-loops | Direction/connectivity tests |

The single-source reference Dijkstra algorithm was not changed to make results agree. Float32 normalization changes some fixture costs; all relevant binary/index fixtures were regenerated from their independent expected-cost generator.

## Verification

| Check | Result |
| --- | --- |
| Core TypeScript suite | **150 passed, 4 skipped** |
| Map installer/storage suite | **20 passed** |
| Python pipeline/publisher suite | **170 passed** |
| Desktop + Pixel 7 emulation browser scenarios | **8 passed** |
| Type checking / production build | Passed |
| Built public-package import smoke test | Passed |
| Published starter packs | **54 verified current files**, **180 real-OSM route comparisons** |
| npm advisory snapshot | No known advisories reported during this implementation |

Browser scenarios cover area selection, download, network-disabled reload, file checking without network, removal, corrupted-download recovery, location coverage boundaries, and a throttled real pause/resume that sends a Range request. These are automated Chromium tests, not physical Android/iOS acceptance.

An independent UI reviewer inspected desktop/mobile initial and offline captures. Its two material findings—scaled map-label readability and remote location feedback—were corrected; the verdict pass marked both resolved. Impeccable engine/schema/detector execution was unavailable; source, screenshots, JSON checks and browser tests supplied the verification instead.

GitHub Actions now includes the app build, map-package tests, published-pack verification, deterministic fixture/pack regeneration and browser checks. Hosted results for these unpushed changes do not exist yet; the results above are local.

## Remaining scope

- Four historical full-Delhi scale tests still skip without the original generated city dataset. The starter-pack checks do not replace them.
- The UI prepares and displays maps. Turn-by-turn navigation, road snapping, route workers, edge-aware path reconstruction and safe-destination semantics remain to be built.
- The default legacy PBF CLI remains a motor-road builder; the starter publisher selects `walking-v1`. Walking policy is conservative and does not cover all jurisdictional, conditional or accessibility rules. Node restrictions apply where present in source snapshots.
- Signed hazards, reconciliation and native BLE remain unimplemented.
- Full-city storage/performance acceptance, physical-device testing, production HTTPS hosting and field validation remain separate work. No APK, GitHub push, merge or deployment was performed.

See [README.md](README.md) to run the app and [docs/MAP_PACKS.md](docs/MAP_PACKS.md) for contracts and recovery details.
