#!/usr/bin/env python3
"""
Build wrapper for the Wali Datalog MGU app.

The MGU app platform links every app against the BMW on-board SDK (oap-sdk),
which is NOT and MUST NOT be committed to this repository. The SDK is supplied
at build time from a donor BMW app, via the community "idrive7-apps" kit
(kit/tools/build.py) or an equivalent toolchain already present on the build
host or head unit.

This wrapper locates that kit and delegates to it. It is intentionally thin so
that this repo stays SDK-free and contains only our own app source.

Resolution order for the kit:
  1. $MGU_KIT               (path to an idrive7-apps checkout)
  2. ../idrive7-apps        (sibling checkout)
  3. ./.mgu-kit            (local checkout)

If no kit/SDK is available, this exits with a clear, non-zero status instead of
producing a broken package.

Usage (invoked by mgu-store's repo-tree build, or by hand):
    python3 scripts/mgu_build.py <app-id> <app-dir>
"""

import os
import shutil
import subprocess
import sys


def find_kit():
    candidates = []
    env = os.environ.get("MGU_KIT")
    if env:
        candidates.append(env)
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    candidates.append(os.path.join(os.path.dirname(here), "idrive7-apps"))
    candidates.append(os.path.join(here, ".mgu-kit"))
    for c in candidates:
        if c and os.path.isfile(os.path.join(c, "kit", "tools", "build.py")):
            return c
    return None


def main(argv):
    app_id = argv[1] if len(argv) > 1 else "wali_datalog"
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    kit = find_kit()
    if not kit:
        sys.stderr.write(
            "\n[mgu_build] No MGU build kit / BMW SDK found.\n"
            "  The app cannot be packaged without the on-board SDK, which this\n"
            "  repository deliberately does not contain.\n"
            "  Set $MGU_KIT to an idrive7-apps checkout (which can extract the\n"
            "  SDK from a donor app with kit/tools/extract_sdk.js), or build on\n"
            "  the head unit where the SDK is present.\n"
            "  See docs/BUILD-AND-INSTALL.md.\n\n"
        )
        return 2

    # Stage our app source into the kit's apps/ dir, then build it there.
    app_src = os.path.join(repo, "apps", app_id)
    app_dst = os.path.join(kit, "apps", app_id)
    if not os.path.isdir(app_src):
        sys.stderr.write("[mgu_build] app source not found: %s\n" % app_src)
        return 2

    if os.path.abspath(app_src) != os.path.abspath(app_dst):
        if os.path.exists(app_dst):
            shutil.rmtree(app_dst)
        shutil.copytree(app_src, app_dst)

    out_dir = os.environ.get("MGU_OUT", os.path.join(repo, "dist"))
    os.makedirs(out_dir, exist_ok=True)

    cmd = [sys.executable, os.path.join("kit", "tools", "build.py"), app_id]
    sys.stderr.write("[mgu_build] delegating to kit: %s (cwd=%s)\n" % (" ".join(cmd), kit))
    rc = subprocess.call(cmd, cwd=kit)
    if rc != 0:
        return rc

    built = os.path.join(kit, "dist")
    copied = 0
    if os.path.isdir(built):
        for name in os.listdir(built):
            if name.startswith(app_id + "@"):
                shutil.copy2(os.path.join(built, name), os.path.join(out_dir, name))
                copied += 1
    if copied == 0:
        sys.stderr.write("[mgu_build] kit build produced no %s@* package\n" % app_id)
        return 1
    sys.stderr.write("[mgu_build] wrote %d package(s) to %s\n" % (copied, out_dir))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
