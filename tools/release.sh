#!/bin/sh
# Build this repository's MGU Store release into dist/release/ (catalog.json + the app packages + icon), ready to
# upload as the assets of a GitHub release tagged "catalog". Needs python3 and node.
#
#   tools/release.sh
#
# BMW's oap-sdk is in no committed or uploaded file. build.py links the app's tests against a placeholder; the head
# unit links the real SDK from a donor app at install time. See docs/BUILD-AND-INSTALL.md.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

# oap-sdk placeholder for the local build (never uploaded; the head unit supplies the real module).
if [ ! -f oap-sdk/index.js ]; then
    mkdir -p oap-sdk
    echo 'module.exports = {}; // placeholder: the real BMW oap-sdk is linked by the head unit at install time' > oap-sdk/index.js
    echo '{"name":"oap-sdk","version":"0.0.0-placeholder","private":true}' > oap-sdk/package.json
fi

SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git -C "$root" log -1 --format=%ct 2>/dev/null || echo 0)}
export SOURCE_DATE_EPOCH

rm -rf dist
python3 kit/tools/build.py wali_datalog                 # iDrive 7: dist/wali_datalog@<v>.tgz + .mgu
python3 kit/tools/build.py --hmi ID8 wali_datalog       # iDrive 8: dist/src/wali_datalog8@<v>.tgz (source package)
python3 tools/release.py --hmi both

echo
echo "release.sh: upload every file of dist/release/ to the GitHub release tagged \"catalog\" of this repository."
