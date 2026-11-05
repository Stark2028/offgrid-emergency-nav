"""Export APKs only when their code and current map data match this web build."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "apps/web"
DIST = WEB / "dist"
catalogue = json.loads((WEB / "src/generated/catalog.json").read_text(encoding="utf-8"))
required = {p.relative_to(DIST).as_posix() for p in DIST.iterdir() if p.is_file()}
for folder in ("assets", "licenses"):
    required.update(p.relative_to(DIST).as_posix() for p in (DIST / folder).rglob("*") if p.is_file())
for region in catalogue["regions"]:
    manifest_path = region["manifestUrl"].lstrip("/")
    manifest = json.loads((DIST / manifest_path).read_text(encoding="utf-8"))
    required.add(manifest_path)
    required.update((Path(manifest_path).parent / asset["path"]).as_posix() for asset in manifest["assets"])

artifacts = []
identities = []
for variant in ("debug", "release"):
    folder = WEB / "android/app/build/outputs/apk" / variant
    metadata = json.loads((folder / "output-metadata.json").read_text(encoding="utf-8"))
    if len(metadata["elements"]) != 1:
        raise RuntimeError("This exporter expects one universal APK per variant")
    element = metadata["elements"][0]
    version, output = element["versionName"], element["outputFile"]
    if not re.fullmatch(r"[0-9A-Za-z.+-]{1,80}", version) or Path(output).name != output:
        raise RuntimeError("Invalid APK output metadata")
    identities.append((metadata["applicationId"], version, element["versionCode"]))
    unsigned = output.endswith("-unsigned.apk")
    suffix = "" if variant == "debug" else "-unsigned" if unsigned else "-release"
    kind = "debug-signed test build" if variant == "debug" else "unsigned optimized release candidate" if unsigned else "release build; verify its distribution signature"
    artifacts.append((folder / output, f"OFFGRID-{version}{suffix}.apk", kind))
if identities[0] != identities[1]:
    raise RuntimeError("Debug and release identities/versions differ")
validated = []
for source, name, kind in artifacts:
    with zipfile.ZipFile(source) as apk:
        for path in sorted(required):
            if apk.read("assets/public/" + path) != (DIST / path).read_bytes():
                raise RuntimeError(f"APK contains stale/different web assets: {name}: {path}; rebuild after sync")
        # Historical generations must not bloat or change the native bundle.
        bundled = {name for name in apk.namelist() if name.startswith("assets/public/packs/") and name.endswith("/manifest.json")}
        expected = {"assets/public/" + r["manifestUrl"].lstrip("/") for r in catalogue["regions"]}
        if bundled != expected:
            raise RuntimeError("APK map generations differ from the current catalogue")
    validated.append((source, name, kind))

target = ROOT / "dist/android"
target.mkdir(parents=True, exist_ok=True)
records = []
for source, name, kind in validated:
    destination = target / name
    shutil.copyfile(source, destination)
    payload = destination.read_bytes()
    records.append({"file": name, "kind": kind, "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()})
report = {
    "version": identities[0][1], "versionCode": identities[0][2], "appId": identities[0][0],
    "status": "Android pilot; field acceptance and production signing pending",
    "artifacts": records,
    "maps": [{k: r[k] for k in ("id", "datasetId", "bounds", "totalBytes", "manifestSha256", "updatedAt")} for r in catalogue["regions"]],
    "nativeInstrumentation": "Not executed by this exporter; recorded device evidence is in docs/ANDROID_RELEASE.md",
}
(target / "verification.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
for record in records:
    print(f"{record['file']}: {record['bytes']:,} bytes; SHA-256 {record['sha256']}")
print(f"Verified {len(required)} current web/map files in each exported APK.")
