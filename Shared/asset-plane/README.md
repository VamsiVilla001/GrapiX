# gx-asset-plane

`.gpxpkg` packages, textures, fonts, glTF. Loss-intolerant but **restartable**.

Two addressing modes are retained deliberately (invariant 31): content hash for
the store, project-relative path for the library, so replacing a file in place
keeps material bindings intact.

Preflight first: the engine reports which content hashes it already holds, and
only the difference ships.

## Publishing a document (5.10)

An engine declares its locality once. A publisher with no control-plane client
(the Editor) reads it from the engine on the asset-plane address it is about to
publish to, with the closed request `{"locality":{}}`, answered
`{"reply":"declared","locality":"CoLocated"|"Lan"}` from the same field the
capability exchange carries. It is read fresh on every publish, never
configured, never inferred from the address, never probed.

`publish_as_package(engine, directory, scene, sources)` is the one publisher
function for documents. It reads the locality, writes one verified package into
`directory` (named by the document's content hash, the process and a sequence
number, never by user text), publishes it through `publish_package` (by path with
no asset bytes to a co-located engine; chunked with only the missing bytes to a
LAN engine), and removes it. A LAN-declared engine reads no path, even if it
holds a package directory: a by-path offer is refused
`PackageDirectoryNotConfigured`. Nothing about the directory goes on the wire.

The asset plane is unauthenticated and binds loopback only. This read is part of
what Phase 14 must authenticate before the plane is exposed beyond loopback.
