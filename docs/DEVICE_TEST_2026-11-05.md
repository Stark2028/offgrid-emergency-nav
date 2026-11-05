# Physical map-renderer follow-up - 5 November 2026

OFFGRID 0.2.1-preview, versionCode 2, Samsung Galaxy M53 / SM-M536B, Android 15 / API 35. The same saved Prayagraj generation from [the original run](DEVICE_TEST_2026-11-04.md) was retained through the update. Dates in this record use India time; raw tool reports use UTC. This record describes the pre-publication device run and does not claim a production identity or production release.

## Measured drag interaction

The screen was awake and OFFGRID was foreground. Three runs each used four 600-ms Android touch swipes. Frame intervals were collected through requestAnimationFrame in the debug WebView. The original SVG camera used 1.5^5 magnification and the new WebGL camera 2^3 (5.3% closer). ADB command gaps are included; these are comparative cadence measurements, not isolated GPU/input-to-pixel latency measurements.

| Run | SVG median / p95 | WebGL median / p95 | WebGL maximum |
| --- | --- | --- | --- |
| 1 | 100.0 / 216.6 ms | 16.7 / 16.8 ms | 16.9 ms |
| 2 | 83.5 / 200.2 ms | 16.7 / 16.8 ms | 17.3 ms |
| 3 | 35.5 / 200.1 ms | 16.7 / 16.8 ms | 17.0 ms |

None of the updated renderer's 557 sampled intervals exceeded 25 ms; no long task was observed during the measured swipes. The old renderer had 76 of 123 intervals over 25 ms. The result supports a substantial improvement on this phone under these conditions. Other devices, initial shader/tile work, memory and battery still need measurement.

## Functional phone checks

All eight updated app checks passed: native bridge, Prayagraj saved, private database present, force-stop recovery, full-file verification, routing with only the WebView network disabled, actual two-touch pinch input, and native Back. The pinch check verifies that screen-space separation of the route pins increases after a two-finger gesture. Native screenshots of the public test route were inspected.

The optimized/R8 copy passed five checks through Android accessibility: WebView debugging disabled, existing Prayagraj preserved, native file verification, navigation opening, and native Back. It was signed with the existing development identity for this device test and is left installed. The exported optimized release candidate remains unsigned. The installed APK was read back and hashed; it matched the prepared local test copy.

| Artifact | SHA-256 |
| --- | --- |
| Exported debug APK | `1adf90ba3caeb5a9d69dde72de5a607dbd093977d6fc276036fd65f79652d79a` |
| Exported optimized unsigned APK | `d00ec1344daee5c36a581bd83abe976918ec25b85c134ea8ad2195d54bfc46ae` |
| Installed optimized development-key copy | `5df7ffc1fb685ce0cb392eb9afcd72bfdb806a07ca2d329aae96bfd1157ee582` |

Both exported APKs contain 1,086 verified current shell/map files. Native build/lint and all 12 browser scenarios passed, including offline reopening and routing. Additional desktop/mobile drag regressions passed. The earlier five native SQLite tests are recorded in the original device report; they were not rerun as part of this renderer-only follow-up.

This run made no location request, stored no precise GPS position, changed no system connectivity/font/location setting, and cleared no app or personal data. WebView network emulation was restored after testing. Device serial is omitted. Ignored local reports/captures remain in `.impeccable/review/`; exported metadata is in `dist/android/verification.json`.

Actual GPS guidance, physical walking/access checks, airplane-mode cold start, broader lifecycle/accessibility and lower-end device acceptance remain in [the release guide](ANDROID_RELEASE.md).
