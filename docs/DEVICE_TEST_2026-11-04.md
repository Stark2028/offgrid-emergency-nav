# Physical Android test record - 4 November 2026

OFFGRID 0.2.0-preview (`org.offgrid.navigation`, versionCode 1), Samsung Galaxy M53 / SM-M536B, Android 15 / API 35, Chrome WebView 153.0.8010.39. Local, uncommitted implementation on `feat/offline-map-setup`; no hosted CI result, GitHub push or production release is claimed.

Prayagraj generation: `0eb38bc04eeae5d03967d910dd6732e38e67bd3b7fa19f7fdca9f75fab8aa1f3`, 9,878,890 bytes / 1,003 assets. Native library and route screenshots were inspected. Device serial and actual location coordinates are omitted.

| Check | Result |
| --- | --- |
| SQLite plugin instrumentation | 5 passed: transactional storage/replacement, native integrity, leases, invalid input and cleanup |
| Debug app | 7 passed: native bridge, save Prayagraj, private database, force-stop recovery, full-file check, WebView-network-disabled route, native Back |
| Optimized/R8 app | 5 passed: WebView debugging disabled, saved map preserved, native file check, navigation opened, native Back |
| Real GPS | User granted precise foreground permission; request returned no usable fix with visible feedback |
| Native build/lint | Debug, Android test APK and optimized unsigned release built; lint passed |
| Exported APK payload | 1,084 current shell/map files matched in each APK; historical generations omitted |
| Browser navigation after junction repair | All 4 desktop/mobile cases passed |

The optimized build was signed with the existing Android **debug** identity for local device testing, installed over the debug build without clearing data, and left installed. The original optimized export stays unsigned. The phone's system network/font/location settings and personal data were not changed. Disabling only the app WebView network was restored afterward; it does not establish an airplane-mode cold-start result.

## Defects found and repaired

1. Native storage rejected small JSON integer offsets through Capacitor's `getLong`, causing four initial instrumentation failures and preventing real saves. Explicit safe-integer decoding now accepts valid integer/double bridge representations and rejects fractional/string/null offsets. The five native tests subsequently passed.
2. A real screen tap near a connected junction was incorrectly rejected as overlapping paths. Candidate projections now normalize to an actual shared graph endpoint within two metres. A synthetic junction regression passes, and unconnected overlapping-level rejection remains tested. Maps/navigation has 33 passing tests.

Original failure logs and subsequent native reports/screenshots remain local under the parent `.review/` and this repository's ignored `.impeccable/review/`. No precise GPS position was recorded.

## Artifact identity

| Artifact | SHA-256 |
| --- | --- |
| Exported debug APK, `OFFGRID-0.2.0-preview.apk` | `c9aafa392e6f0bdbb1b471c7bc464be433171013a1bb35cb42277515f0741f98` |
| Exported optimized unsigned APK | `6a33b5856d9bd2718a7809474409c1abfb89c819214f05ff3bc2cb75f3924d9a` |
| Installed optimized APK, debug-key test copy | `3c62e2b2e6f410df572eed33116030370e434e02ddd1cbef91c78ecf290fe4ae` |

The installed optimized APK hash was read back from OFFGRID's installed package and matched the local signed copy. Debug certificate SHA-256: `937a10ea75666b7d5493eb405a8c6e037a0d60d73a36951632ea96ab045b4a97`. This is a development certificate, not an owned production distribution identity. Exported sizes, hashes, map identities and test counts are in `dist/android/verification.json`.

## Still required

A successful real GPS fix and familiar walking test; actual airplane-mode cold start; background/lock/return, rotation and interruptions; TalkBack and large fonts; low-space and app-upgrade recovery; representative lower-end devices; river-crossing/access inspection; production signing and controlled distribution. BLE hazard sharing and emergency-safe-destination semantics remain unimplemented. See [the release guide](ANDROID_RELEASE.md).
