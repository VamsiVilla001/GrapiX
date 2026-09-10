# gx-asset-plane

`.gpxpkg` packages, textures, fonts, glTF. Loss-intolerant but **restartable**.

Two addressing modes are retained deliberately (invariant 31): content hash for
the store, project-relative path for the library, so replacing a file in place
keeps material bindings intact.

Preflight first: the engine reports which content hashes it already holds, and
only the difference ships.
