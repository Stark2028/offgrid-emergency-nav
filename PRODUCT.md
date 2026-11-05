# Product

<!-- impeccable:product-schema 1 -->

## Platform

android

## Users

People preparing a phone for navigation when internet access may disappear.

## Product Purpose

Prepare a phone with a clearly bounded offline map, then plan and follow a walking route on the device. The Android pilot uses Prayagraj for first field acceptance and retains a web companion.

## Operating Context

The user approved a first-time flow: choose a city/region manually or with optional location, inspect coverage and actual size, download resumably, verify, and manage downloaded areas. The Android pilot bundles its published packs for local saving; the web companion downloads from its HTTPS origin. Walking navigation and foreground guidance are implemented. Production release still requires native/field acceptance; safe destinations and BLE are not shipped features.

## Capabilities and Constraints

- Existing Python graph pipeline and DOM-free TypeScript routing core are retained.
- React + TypeScript + Vite is shared by Android/Capacitor and the browser companion. Native Android storage is private SQLite; location uses native permissions and foreground watches.
- Maps are published static assets, with manifests pinned by the application catalogue.
- Only packs actually built and included in the catalogue may be offered for download.
- Coverage must describe the actual dataset, including starter-area limitations.
- A staged or interrupted download must not replace a verified installed generation.
- No accounts, central routing service, location telemetry, or automatic location permission request.

## Brand Commitments

OFFGRID. Plain, direct, factual language. Never imply a place is guaranteed safe.

## Evidence on Hand

Routing fixtures and pipeline code are available. The historical Delhi production dataset is absent. Starter source data must carry its provenance; synthetic fixtures must never be presented as city maps.

## Product Principles

1. Show coverage before asking for a download.
2. Readiness describes verified local files, not an animation or an online flag.
3. Recover from interruption without sacrificing a working map.
4. Keep private location on the device.

## Accessibility & Inclusion

Keyboard-operable controls, large primary touch targets, readable contrast, reduced-motion support, and text equivalents for map coverage and progress.
