# Android pilot and release gates

Updated 5 November 2026. OFFGRID has a Capacitor 8 Android application with private native SQLite map storage and foreground native location guidance. Its present release is **0.2.1-preview** (versionCode 2), for device and field testing. It replaces the SVG interaction renderer with a locally bundled MapLibre WebGL map; see [map performance and measurement](MAP_RENDERING.md). A successful APK build is not a field-readiness certification.

## First phone test: Prayagraj

Prayagraj is the first area in the catalogue. Its 841.80 km² download rectangle is west 81.73°, south 25.32°, east 82.02°, north 25.58°. It includes the central city and the named areas of Naini, Jhunsi and Phaphamau. This rectangle is download coverage, not an official municipal/district boundary. Check the displayed outline for any particular destination.

The current generation contains **9,878,890 bytes in 1,003 verified files**, including 1,002 routing tiles and the street drawing. It is built from a frozen public OpenStreetMap snapshot; the source timestamp/checksum and all asset hashes are pinned in the catalogue and manifest. Named places include stations, suburbs and available medical/police features; names do not certify an entrance or current opening status.

The pilot APK bundles the published map packs. **Save this area** copies and verifies the chosen data into private native storage, including without an internet connection. Removing a saved area removes that copy; the bundled compressed source remains part of the installed APK. This delivery model makes the pilot self-contained. A public map catalogue/CDN, independently signed catalogue updates and downloads of additional regions are still release work. The web companion downloads the same files from its HTTPS origin.

1. Install the debug APK on the test phone. It uses the Android debug signing identity; it is not the production distribution key.
2. Open OFFGRID, select **Prayagraj — City & river crossings**, inspect coverage and source date, and choose **Save this area**.
3. Wait for **Saved on this device**. Open walking navigation. Choose a start/destination from the local place list or the map. Location is requested only after the user chooses it.
4. Check a short familiar route first. Guidance uses the mapped path and approximate walking time. Verify entrances, access, crossings and actual bridge availability in person.
5. Enable airplane mode, close/reopen the app, and repeat. Saved maps and route calculation should work without connectivity.

## Device acceptance to record before production

Record the phone model, Android version, WebView version, app/map generation, result and any failure for each case. Retain the original failing case when repairing an issue.

### Recorded physical-phone run: 4 November 2026

Samsung Galaxy M53 (SM-M536B), Android 15 / API 35, Chrome WebView 153.0.8010.39, app 0.2.0-preview. The Prayagraj generation was `0eb38bc04eeae5d03967d910dd6732e38e67bd3b7fa19f7fdca9f75fab8aa1f3`.

All **five native SQLite instrumentation tests passed**. All **seven app checks passed**: native bridge availability, Prayagraj save, private database presence, force-stop recovery, full-file verification, routing with the WebView network disabled, and Android Back. Native library/route screenshots were inspected. This run preserved app data and did not change the phone's system connectivity, font settings or location settings.

The 0.2.0 optimized/R8 build was also installed as a separate test copy signed with the existing development identity. Five checks passed through Android accessibility: WebView debugging remained disabled, the existing Prayagraj map survived, native file verification succeeded, navigation opened, and Android Back returned to the library. Build hashes and the limits of that earlier run are recorded in [the original device test record](DEVICE_TEST_2026-11-04.md).

### Map-performance follow-up: 5 November 2026

On the same Samsung, 0.2.1 passed eight updated app checks: native bridge, existing Prayagraj saved map, private database, force-stop recovery, full-file verification, WebView-network-disabled routing, actual two-touch pinch zoom, and native Back. Three repeatable drag runs had median/p95 frame intervals of 16.7/16.8 ms, with no interval over 25 ms among 557 samples. The original SVG baseline had p95 intervals around 200-217 ms; the method and limitations are in [map performance](MAP_RENDERING.md).

The 0.2.1 optimized test copy also passed all five accessibility-driven checks and is now installed. Upgrading preserved the existing map. WebView debugging is disabled in that copy; it uses the development signing identity, while the exported release candidate stays unsigned. No location request or system-setting change was made during this follow-up. See [the updated device record](DEVICE_TEST_2026-11-05.md).

The user granted precise foreground location permission through Android. The subsequent request returned no usable fix and displayed feedback. A successful real GPS fix, actual walking guidance and reopening after system airplane mode are still open; WebView network emulation does not establish those results. Reports retain only the location outcome category, not coordinates or a GPS screenshot.

Two defects surfaced only during this device run and were repaired: native map offsets were rejected because Capacitor's `getLong` does not accept small JSON `Integer` values; explicit finite safe-integer decoding now handles them. Near-junction pins could falsely appear to select overlapping paths; candidates now normalize to an actual shared graph endpoint within two metres, while unconnected crossing levels remain rejected. Native and navigation regressions cover these cases.

| Case | Required evidence | Current state |
| --- | --- | --- |
| Native storage | Save, force-stop, reopen offline, verify; confirm map database survives | Five SQLite tests and save/force-stop/reopen/file-check passed on Samsung M53; system-airplane-mode reopening pending |
| Interrupted save/update | Interrupt at early/mid/late progress; resume; old map survives failed replacement | Browser/installer regressions pass; native phone pending |
| Permission and GPS | Denied/approximate permission, disabled location, no fix, stale fix, recovery, outside coverage | Browser cases pass; native permission prompt/grant and no-fix feedback observed; usable GPS fix and wider native cases pending |
| Real walk | Familiar 10–20 minute walk, correct start/entrance, off-route warning and recalculation | Pending physical phone |
| River areas | Manually inspect selected Naini/Jhunsi/Phaphamau connections and present-day access | Data/graph checks pass; field checks pending |
| Lifecycle | Home, lock screen, return, Back, rotation, incoming call | Force-stop recovery and native Back passed on M53; other lifecycle cases pending |
| Accessibility | TalkBack, large font, contrast, keyboard, touch targets and both orientations | Browser focus/layout checked; native acceptance pending |
| Storage pressure | Low-space failure, damaged/missing data, removal, app update and reinstall behavior | Installer regressions pass; Android acceptance pending |
| Performance | Cold start, save/check duration, route latency, memory and battery on a representative lower-end phone | M53 drag comparison and two-touch pinch passed; cold-start timing, memory/battery and lower-end devices still pending |

Guidance deliberately pauses when the app goes into the background. It is **foreground walking guidance**; background/lock-screen navigation, spoken directions, wheelchair routing, trustworthy safe destinations, signed hazard sharing and BLE mesh are not shipped capabilities. The current map is a street/path drawing, not a complete cartographic basemap with water/terrain layers. These limitations must remain visible in release scope.

## Build and verify

Install Node 22.12+, pnpm 12.3.4, JDK 21, Android SDK platform/build tools 36 and platform-tools. From the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:packs
powershell -ExecutionPolicy Bypass -File tools/android-build.ps1
```

The build helper uses `JAVA_HOME` and `ANDROID_HOME` (or the standard Windows SDK location), fails if the web build/sync fails, then assembles Android and runs lint. `pnpm --filter @offgrid/web android:sync` copies the production web output and removes historical generations only from the generated Android copy. The web publication retains immutable historical generations.

Artifacts are under `apps/web/android/app/build/outputs/apk/`. After both debug and release have been built from the same synced web output, `python tools/export_android.py` validates every current shell/map file inside both APKs and exports named artifacts plus SHA-256 records to `dist/android/`. Debug is installable. Release is unsigned unless all four signing environment variables are supplied: `OFFGRID_KEYSTORE`, `OFFGRID_STORE_PASSWORD`, `OFFGRID_KEY_ALIAS`, `OFFGRID_KEY_PASSWORD`. Never commit a key or password. Back up the real release identity before distribution; verify upgrade compatibility and increase `versionCode` for each release. No production signing identity has been created here.

On a connected **test** device, select its serial explicitly:

```powershell
adb devices
adb -s DEVICE_SERIAL install -r apps/web/android/app/build/outputs/apk/debug/app-debug.apk
```

Android instrumentation tests exercise actual SQLite rollback, native SHA verification, exclusive leases, invalid identifiers, cleanup and active-pointer replacement. Run `:app:connectedDebugAndroidTest` with a booted device. The emulator-only `pnpm --filter @offgrid/web test:android` smoke script changes emulator connectivity/font settings and restores them afterward; it refuses a personal-phone serial. It checks private storage, force-stop recovery, offline routes, native Back and captures actual Android screens. GitHub Android CI is configured to run both; that workflow must be green before releasing.

For an explicitly authorized personal phone, install the debug APK, then use the separate helpers below. They never clear app data, grant permissions, toggle phone connectivity/font settings or inject GPS. The first helper force-stops only OFFGRID and briefly disables only its WebView network; it restores that network in cleanup. Location permission remains the user's Android choice. Reports/screenshots are ignored local evidence under `.impeccable/review/`, not committed personal-device data.

```powershell
$env:OFFGRID_ADB_SERIAL='DEVICE_SERIAL'
$env:ANDROID_HOME='C:/path/to/Android/Sdk'
node apps/web/tools/phone-smoke.mjs
node apps/web/tools/phone-gps-check.mjs
```

`python tools/phone_release_smoke.py` checks an already installed optimized build through Android accessibility, leaving release WebView debugging disabled. For local optimization testing only, a copy of the unsigned APK may be signed with the same development identity as the installed debug build; this does not create a production release. Keep that copy separate from the exported unsigned release candidate.

On this Windows host, platform-tools 37.0.1's new USB backend did not maintain the Samsung connection. The documented `ADB_USB_LEGACY=1` process-environment fallback, followed by restarting the idle ADB server, restored detection. The user then authorized the host through the phone's normal USB debugging prompt. See [Google's platform-tools release notes](https://developer.android.com/tools/releases/platform-tools). No persistent OS environment or phone security setting was changed.

Local emulator attempts with SDK emulator 37.1.11, compatibility graphics, software emulation and archived 36.6.11 did not boot. The last attempt terminated with Windows access-violation status `0xC0000005` before the guest kernel or app started. The subsequent physical-phone evidence above is separate from browser emulation. No physical walk is claimed.

## Release controls

- Native maps live in a private SQLite database, not WebView cache. File payloads cross the bridge in bounded chunks/batches, with native SHA-256 verification and transactional activation. Native admission limits are 64 MiB payload, 5,000 assets, 1 MiB manifest metadata and 32 MiB per file; the tested Prayagraj pack is much smaller.
- The app uses a local HTTPS WebView origin, no remote app URL, strict content policy, no cleartext transport, disabled cloud/device-transfer backup and disabled native logging. WebView debugging is enabled only in the debug build. WebView 117 or newer is required.
- Location is kept in memory and used on the device. There are no application-server location uploads or accounts. Watches stop when guidance stops, the screen closes or the app backgrounds.
- Published routes respect directed foot access and saved bounds. The pipeline preserves walking speed changes and excludes explicitly temporary, floating/pontoon, ford, seasonal or unevaluated conditional-access paths. Missing tags cannot establish real-world access. Ambiguous overlapping paths require another point instead of silently selecting a crossing level.
- Release approval still requires passing native/field evidence, a user-owned signing identity, validated upgrade/recovery, public delivery/privacy details and truthful product scope. BLE/emergency-safety claims require their own implementation and multi-device validation.
