# Consolidated historical source

The user requested merging all former agent worktrees into one workspace.
`grapix-1x/` imports the complete tracked source of `middle-layer-arch` at
`ca999044ea21c447a1b689a2e2c3ab1f9b6a4446`. Its full Git history is a parent
of the consolidation merge, rather than a disconnected archive. The
current 2.0 manifests, contracts and runtime remain at repository root.

`agent-orphans/figma-import-motion-config-f13e17/` preserves the 48 source
files from an unregistered partial checkout; many are older versions of
current files. They were retained separately to avoid replacing current
contracts with incomplete historical versions. Generated dependencies,
build outputs and temporary files were excluded.

These source trees are not additional Git worktrees and are not part of the
current production build or boundary scan. Apply the same shared-worktree
policy when inspecting or porting anything from them. Legacy runtime data
and private settings remain local under `agent/archive/`.
