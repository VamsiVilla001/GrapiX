import os, shutil, subprocess, sys

WT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".."))
import tempfile
OUT = tempfile.mkdtemp(prefix="gx-dock-mutants-")  # the logs of each run; not kept
M = os.path.join(WT, "Editor", "src", "dock-model.ts")
V = os.path.join(WT, "Editor", "src", "dock-validate.ts")
R = os.path.join(WT, "Editor", "src", "panel-registry.ts")
G = os.path.join(WT, "Editor", "src", "workspace-manager.ts")
I = os.path.join(WT, "Editor", "src", "workspace-io.ts")
TESTS = "npx vitest run Editor/tests/dock-model.test.ts Editor/tests/dock-validate.test.ts Editor/tests/panel-registry.test.ts Editor/tests/workspace-manager.test.ts Editor/tests/workspace-io.test.ts"

MUTANTS = [
    # dock-model: normalising
    ("empty-group-kept", M, "    if (node.panelInstanceIds.length === 0) return null;\n    const active =", "    const active ="),
    ("one-child-split-kept", M, "  if (children.length === 1) return children[0]!;\n", ""),
    ("same-direction-not-joined", M, "if (kept.kind === \"split\" && kept.direction === node.direction) {", "if (false) {"),
    ("joined-weights-not-multiplied", M, "weights.push(weight * (kept.weights[at] ?? 0));", "weights.push(kept.weights[at] ?? 0);"),
    ("weights-not-normalised", M, "return { ...node, children, weights: normalizeWeights(weights) };", "return { ...node, children, weights };"),
    ("active-not-fixed", M, "return active === node.activePanelInstanceId ? node : { ...node, activePanelInstanceId: active };", "return node;"),
    ("empty-float-kept", M, "    return kept === null ? [] : [{ ...float, root: kept }];", "    return [{ ...float, root: kept ?? float.root }];"),
    ("stale-maximize-kept", M, "...(maximizedGroupId !== undefined && ids.has(maximizedGroupId) ? { maximizedGroupId } : {}),", "...(maximizedGroupId !== undefined ? { maximizedGroupId } : {}),"),
    ("stale-active-group-kept", M, "...(activeGroupId !== undefined && ids.has(activeGroupId) ? { activeGroupId } : {}),", "...(activeGroupId !== undefined ? { activeGroupId } : {}),"),
    # weights
    ("equal-shares-for-unusable-dropped", M, "if (!usable || !(total > 0) || !Number.isFinite(total)) return weights.map(() => 1 / weights.length);", "if (!usable) return [...weights];"),
    # closing
    ("close-neighbour-wrong", M, "? (panelInstanceIds[Math.min(at, panelInstanceIds.length - 1)] ?? null)", "? (panelInstanceIds[0] ?? null)"),
    ("close-keeps-instance", M, "  return finish({ ...next, instances });", "  return finish({ ...next });"),
    ("close-unknown-allowed", M, "  if (group === undefined) return refuse(\"PANEL_NOT_AVAILABLE\", `no open panel is called ${instanceId}`);\n  const next = mapTrees(workspace, (tree) => editGroup(tree, group.id, (g) => withoutInstance(g, instanceId)));", "  if (group === undefined) return workspace;\n  const next = mapTrees(workspace, (tree) => editGroup(tree, group.id, (g) => withoutInstance(g, instanceId)));"),
    # placing
    ("side-drop-half-wrong", M, "const share = (current.weights[index] ?? 0) / 2;", "const share = (current.weights[index] ?? 0) / 3;"),
    ("before-after-swapped", M, "children.splice(before ? index : index + 1, 0, node);", "children.splice(before ? index + 1 : index, 0, node);"),
    ("wrap-order-swapped", M, "children: before ? [node, current] : [current, node] };", "children: before ? [current, node] : [node, current] };"),
    ("vertical-is-horizontal", M, "const direction: Direction = position === \"left\" || position === \"right\" ? \"horizontal\" : \"vertical\";", "const direction: Direction = position === \"left\" || position === \"right\" ? \"vertical\" : \"horizontal\";"),
    ("same-direction-check-dropped", M, "if (index >= 0 && current.direction === direction) {", "if (index >= 0) {"),
    ("alone-beside-self-allowed", M, "  if (destination.id === source.id && position !== \"center\" && source.panelInstanceIds.length === 1) {", "  if (false) {"),
    ("center-index-ignored", M, "const at = Math.max(0, Math.min(index ?? rest.length, rest.length));", "const at = rest.length;"),
    ("center-not-activated", M, "return { ...group, panelInstanceIds: rest, activePanelInstanceId: instanceId };", "return { ...group, panelInstanceIds: rest };"),
    ("moved-panel-not-removed", M, "  let next = mapTrees(workspace, (tree) => editGroup(tree, source.id, (group) => withoutInstance(group, instanceId)));\n  if (position === \"center\") {", "  let next = workspace;\n  if (position === \"center\") {"),
    ("new-group-id-clash", M, "const groupId = freshId(next, `${workspace.instances[instanceId]?.panelType ?? \"panel\"}-group`);", "const groupId = `${workspace.instances[instanceId]?.panelType ?? \"panel\"}-group`;"),
    ("bad-position-allowed", M, "  if (position !== \"center\" && !isSide(position)) return refuse(\"INVALID_DOCK_TARGET\", `${String(position)} is not a place to dock`);\n  if (destination.id === source.id && position", "  if (destination.id === source.id && position"),
    ("move-focus-lost", M, "  return now === undefined ? placed : { ...placed, activeGroupId: now.id };", "  return placed;"),
    # moving a group
    ("group-onto-itself-allowed", M, "  if (source.id === destination.id) return refuse(\"INVALID_DOCK_TARGET\", \"a group cannot be moved onto itself\");", ""),
    ("group-merge-active-lost", M, "activePanelInstanceId: source.activePanelInstanceId,\n      })),", "activePanelInstanceId: group.activePanelInstanceId,\n      })),"),
    ("group-merge-order-swapped", M, "panelInstanceIds: [...group.panelInstanceIds, ...source.panelInstanceIds],", "panelInstanceIds: [...source.panelInstanceIds, ...group.panelInstanceIds],"),
    ("group-not-detached", M, "  const detached = mapTrees(workspace, (tree) => editGroup(tree, source.id, (group) => ({ ...group, panelInstanceIds: [], activePanelInstanceId: null })));", "  const detached = workspace;"),
    # reorder, maximise, focus
    ("reorder-nan-allowed", M, "  if (!Number.isFinite(index)) return refuse(\"INVALID_DOCK_TARGET\", \"a tab cannot be put at a place that is not a number\");\n", ""),
    ("reorder-unclamped", M, "rest.splice(Math.max(0, Math.min(Math.trunc(index), rest.length)), 0, instanceId);", "rest.splice(Math.trunc(index), 0, instanceId);"),
    ("maximize-changes-tree", M, "return { ...workspace, maximizedGroupId: groupId, activeGroupId: groupId };", "return { ...workspace, root: { ...workspace.root }, maximizedGroupId: groupId, activeGroupId: groupId, floats: [] };"),
    ("restore-any-group", M, "return maximizedGroupId === groupId ? rest : workspace;", "return rest;"),
    ("focus-keeps-other-maximise", M, "    ...(maximizedGroupId === group.id ? { maximizedGroupId } : {}),", "    ...(maximizedGroupId !== undefined ? { maximizedGroupId } : {}),"),
    ("focus-active-group-lost", M, "    activeGroupId: group.id,\n", ""),
    # resizing
    ("divider-no-clamp-low", M, "const moved = Math.min(high, Math.max(low, before + delta));", "const moved = Math.min(high, before + delta);"),
    ("divider-no-clamp-high", M, "const moved = Math.min(high, Math.max(low, before + delta));", "const moved = Math.max(low, before + delta);"),
    ("divider-minimums-ignored", M, "const minimum = (child: number): number => Math.max(MIN_FRACTION, minimums?.[child] ?? 0);", "const minimum = (child: number): number => MIN_FRACTION;"),
    ("divider-tight-pair-moved", M, "  if (low > high) return workspace;\n", ""),
    ("divider-pair-sum-lost", M, "weights[dividerIndex + 1] = pair - moved;", "weights[dividerIndex + 1] = after;"),
    ("divider-nan-allowed", M, "  if (!Number.isFinite(delta)) return refuse(\"INVALID_DOCK_TARGET\", \"a divider cannot be moved by an amount that is not a number\");\n", ""),
    ("divider-index-unchecked", M, "  if (!Number.isInteger(dividerIndex) || dividerIndex < 0 || dividerIndex >= split.children.length - 1) {", "  if (false) {"),
    ("weights-length-unchecked", M, "  if (weights.length !== split.children.length) return refuse(", "  if (false) return refuse("),
    ("weights-zero-allowed", M, "if (!weights.every((weight) => Number.isFinite(weight) && weight > 0)) return refuse(\"INVALID_DOCK_TARGET\", \"every weight must be a positive number\");", "if (!weights.every((weight) => Number.isFinite(weight))) return refuse(\"INVALID_DOCK_TARGET\", \"every weight must be a positive number\");"),
    ("weights-not-scaled", M, "  const scaled = normalizeWeights(weights);", "  const scaled = [...weights];"),
    ("fresh-id-ignores-instances", M, "    ...Object.keys(workspace.instances),\n", ""),
    ("fresh-id-ignores-floats", M, "    ...workspace.floats.map((float) => float.id),\n", ""),
    ("walk-loops", M, "  if (seen.has(node)) return;\n  seen.add(node);\n  yield node;", "  yield node;"),
    # validate
    ("rule1-record-missing-ignored", V, "if (workspace.instances[id] === undefined) problems.push(", "if (false) problems.push("),
    ("rule1-twice-ignored", V, "if (times > 1) problems.push({ rule: 1,", "if (false) problems.push({ rule: 1,"),
    ("rule1-orphan-ignored", V, "if (!referenced.has(key)) problems.push(", "if (false) problems.push("),
    ("rule3-empty-allowed", V, "if (!(isRoot && root)) problems.push({ rule: 3, reason: `tab group ${node.id} holds no panel` });", ""),
    ("rule3-active-unchecked", V, "} else if (node.activePanelInstanceId === null || !node.panelInstanceIds.includes(node.activePanelInstanceId)) {", "} else if (false) {"),
    ("rule3-maximised-unchecked", V, "if (workspace.maximizedGroupId !== undefined && !groupIds.has(workspace.maximizedGroupId)) {", "if (false) {"),
    ("rule4-one-child-allowed", V, "if (node.children.length < 2) problems.push(", "if (false) problems.push("),
    ("rule4-length-unchecked", V, "if (node.weights.length !== node.children.length) {", "if (false) {"),
    ("rule4-nonpositive-allowed", V, "} else if (!node.weights.every((weight) => Number.isFinite(weight) && weight > 0)) {", "} else if (!node.weights.every((weight) => Number.isFinite(weight))) {"),
    ("rule4-sum-unchecked", V, "} else if (Math.abs(node.weights.reduce((sum, weight) => sum + weight, 0) - 1) > WEIGHT_SUM_TOLERANCE) {", "} else if (false) {"),
    ("rule4-tolerance-too-tight", V, "const WEIGHT_SUM_TOLERANCE = 1e-6;", "const WEIGHT_SUM_TOLERANCE = 1e-12;"),
    ("rule5-dup-ids-ignored", V, "if (times > 1) problems.push({ rule: 5, reason: `the id ${id} is used ${times} times` });", ""),
    ("rule5-float-ids-ignored", V, "  for (const float of workspace.floats) count(float.id);\n", ""),
    ("rule5-shared-node-ignored", V, "    if (seen.has(node) || seenObjects.has(node)) {", "    if (seen.has(node)) {"),
    ("rule7-nan-bounds-allowed", V, "if (![x, y, width, height].every(Number.isFinite)) problems.push(", "if (false) problems.push("),
    ("rule7-no-size-allowed", V, "else if (!(width > 0 && height > 0)) problems.push(", "else if (false) problems.push("),
    ("rule9-key-ignored", V, "if (SECRET_KEY.test(key)) found.push(`${path}.${key}`);\n      else secretsIn", "if (false) found.push(`${path}.${key}`);\n      else secretsIn"),
    ("rule9-value-ignored", V, "if (SECRET_VALUE.test(value.trim())) found.push(path);", ""),
    ("rule9-context-ignored", V, "  for (const instance of Object.values(workspace.instances)) secretsIn(instance.context, `instances.${instance.instanceId}.context`, 0, secrets);\n", ""),
    ("rule9-depth-unbounded", V, "  if (depth > 12) return;\n", ""),
    # registry
    ("registry-duplicate-allowed", R, "    if (seen.has(type)) return bad(type, \"that type is already registered\");", ""),
    ("registry-name-unchecked", R, "if (typeof type !== \"string\" || !TYPE_NAME.test(type)) return bad(", "if (false) return bad("),
    ("registry-single-and-many-allowed", R, "if (definition.singleton && definition.allowMultiple) return bad(", "if (false) return bad("),
    ("registry-pin-without-many-allowed", R, "if (definition.supportsContextPin === true && !definition.allowMultiple) return bad(", "if (false) return bad("),
    ("registry-size-unchecked", R, "if (!(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)) return bad(", "if (false) return bad("),
    ("registry-title-unchecked", R, "if (definition.title.trim() === \"\") return bad(", "if (false) return bad("),
    ("registry-app-unchecked", R, "if (definition.app !== \"editor\" && definition.app !== \"playout\" && definition.app !== \"both\") return bad(", "if (false) return bad("),
    ("registry-hint-unchecked", R, "if (groupHint.trim() === \"\") return bad(", "if (false) return bad("),
    ("registry-tab-unchecked", R, "if (tabIndex !== undefined && !(Number.isInteger(tabIndex) && tabIndex >= 0)) return bad(", "if (false) return bad("),
    ("registry-capability-blank-allowed", R, "if (definition.capability !== undefined && definition.capability.trim() === \"\") return bad(", "if (false) return bad("),
    ("for-app-ignores-both", R, "forApp: (app) => definitions.filter((definition) => definition.app === \"both\" || definition.app === app),", "forApp: (app) => definitions.filter((definition) => definition.app === app),"),
    ("unavailable-unknown-ok", R, "if (definition === undefined) return `this build does not know a panel called ${panelType}`;", "if (definition === undefined) return undefined;"),
    ("unavailable-app-ignored", R, "if (definition.app !== \"both\" && definition.app !== app) return", "if (false) return"),
    ("unavailable-capability-ignored", R, "if (definition.capability !== undefined && !capabilities.has(definition.capability)) {", "if (false) {"),
    # manager
    ("open-ignores-unavailable", G, "  if (why !== undefined) return { code: \"PANEL_NOT_AVAILABLE\", refused: why };", ""),
    ("open-duplicates-open-panel", G, "  if (open.length > 0 && (!options.newInstance || single)) {", "  if (false) {"),
    ("open-singleton-second-allowed", G, "    if (options.newInstance) {\n      return { code: \"DUPLICATE_SINGLETON\"", "    if (false) {\n      return { code: \"DUPLICATE_SINGLETON\""),
    ("open-single-allows-many-flag-ignored", G, "const single = definition.singleton || !definition.allowMultiple;", "const single = definition.singleton;"),
    ("open-instance-id-clash", G, "if (workspace.instances[id] === undefined && freshId(workspace, id) === id) return id;", "return id;"),
    ("open-tab-index-ignored", G, "const at = Math.max(0, Math.min(definition.defaultPlacement?.tabIndex ?? node.panelInstanceIds.length, node.panelInstanceIds.length));", "const at = node.panelInstanceIds.length;"),
    ("open-placement-hint-ignored", G, "  const hinted = hint === undefined ? undefined : findGroup(workspace, hint);\n  if (hinted !== undefined) return hinted;", ""),
    ("open-active-group-ignored", G, "  if (active !== undefined) return active;\n  return groups", "  return groups"),
    ("open-not-activated", G, "return { ...node, panelInstanceIds: ids, activePanelInstanceId: instanceId };", "return { ...node, panelInstanceIds: ids };"),
    ("open-record-missing", G, "instances: { ...workspace.instances, [instanceId]: { instanceId, panelType } },", "instances: workspace.instances,"),
    ("open-keeps-hiding-maximise", G, "...(maximizedGroupId === target.id ? { maximizedGroupId } : {}),", "...(maximizedGroupId !== undefined ? { maximizedGroupId } : {}),"),
    ("open-active-group-not-set", G, "    activeGroupId: target.id,\n", ""),
    ("close-unclosable-allowed", G, "  if (definition !== undefined && !definition.allowClose) {", "  if (false) {"),
    ("unavailable-list-empty", G, "return reason === undefined ? [] : [{ instanceId: instance.instanceId, panelType: instance.panelType, reason }];", "return [];"),
    # io
    ("read-newer-schema-read", I, "  if (version > WORKSPACE_SCHEMA_VERSION) {", "  if (false) {"),
    ("read-skips-validation", I, "  const problems = validateWorkspace(workspace);\n  if (problems.length > 0) return rejected(problems);", ""),
    ("read-input-mutated-by-migrate", I, "let raw = structuredClone(value) as Record<string, unknown>;", "let raw = value as Record<string, unknown>;"),
    ("alias-chain-one-hop", I, "hops < 8; hops += 1) {", "hops < 1; hops += 1) {"),
    ("alias-not-reported", I, "if (!renamed.includes(label)) renamed.push(label);", ""),
    ("alias-not-applied", I, "      entry[\"panelType\"] = type;", ""),
    ("version-zero-allowed", I, "if (typeof version !== \"number\" || !Number.isInteger(version) || version < 1) {", "if (typeof version !== \"number\") {"),
    ("depth-unlimited", I, "if (depth > MAX_DEPTH) fail(path,", "if (false) fail(path,"),
    ("layout-collapsed-full-share", I, "const share = (region: RegionId): number => (layout.regions[region].collapsed ? COLLAPSED_SHARE : Math.max(layout.regions[region].size, COLLAPSED_SHARE));", "const share = (region: RegionId): number => Math.max(layout.regions[region].size, COLLAPSED_SHARE);"),
    ("layout-split-always-applied", I, "const fits = stored !== undefined && stored.entries.length === keys.length && stored.entries.every((key, index) => key === keys[index]);", "const fits = stored !== undefined;"),
    ("layout-active-lost", I, "activePanelInstanceId: `${entry.group.active}-1` };", "activePanelInstanceId: ids[0] ?? null };"),
    ("layout-bottom-share-wrong", I, "weights: normalizeWeights([1 - share(\"bottom\"), share(\"bottom\")]),", "weights: normalizeWeights([share(\"bottom\"), 1 - share(\"bottom\")]),"),
    ("layout-columns-swapped", I, "  if (left !== undefined) columns.push({ node: left, weight: share(\"left\") });\n  if (middle !== undefined) columns.push({ node: middle, weight: share(\"centre\") });\n  if (right !== undefined) columns.push({ node: right, weight: share(\"right\") });", "  if (right !== undefined) columns.push({ node: right, weight: share(\"right\") });\n  if (middle !== undefined) columns.push({ node: middle, weight: share(\"centre\") });\n  if (left !== undefined) columns.push({ node: left, weight: share(\"left\") });"),
]


# After the code review of 23 Nov the code changed: these no longer match and are replaced below.
STALE = {
    "center-index-ignored", "new-group-id-clash", "move-focus-lost", "focus-keeps-other-maximise", "focus-active-group-lost",
    "rule1-record-missing-ignored", "rule9-key-ignored", "rule9-value-ignored", "rule9-depth-unbounded",
    "open-instance-id-clash", "open-keeps-hiding-maximise", "open-active-group-not-set",
    "layout-collapsed-full-share", "layout-columns-swapped",
}
ROW = "  if (left !== undefined) row.push({ node: left, weight: leftShare });\n  if (centre !== undefined) row.push({ node: centre, weight: Math.max(MIN_CENTRE_SHARE, 1 - leftShare - rightShare) });\n  if (right !== undefined) row.push({ node: right, weight: rightShare });"
MUTANTS = [m for m in MUTANTS if m[0] not in STALE] + [
    # replacements for the stale ones
    ("center-index-ignored", M, "const at = Math.max(0, Math.min(index === undefined ? rest.length : Math.trunc(index), rest.length));", "const at = rest.length;"),
    ("new-group-id-clash", M, "const groupId = freshId(next, `${instanceOf(workspace, instanceId)?.panelType ?? \"panel\"}-group`);", "const groupId = `${instanceOf(workspace, instanceId)?.panelType ?? \"panel\"}-group`;"),
    ("move-focus-lost", M, "  return now === undefined ? placed : withFocus(placed, now.id);", "  return placed;"),
    ("focus-keeps-other-maximise", M, "    ...(maximizedGroupId === groupId ? { maximizedGroupId } : {}),", "    ...(maximizedGroupId !== undefined ? { maximizedGroupId } : {}),"),
    ("focus-active-group-lost", M, "    activeGroupId: groupId,\n    ...(maximizedGroupId === groupId", "    ...(maximizedGroupId === groupId"),
    ("rule1-record-missing-ignored", V, "if (instanceOf(workspace, id) === undefined) problems.push(", "if (false) problems.push("),
    ("rule9-key-ignored", V, "if (isSecretKey(key)) found.push({ path: `${path}.${key}`, kind: \"secret\" });", "if (false) found.push({ path: `${path}.${key}`, kind: \"secret\" });"),
    ("rule9-value-ignored", V, "if (isSecretValue(value)) found.push({ path, kind: \"secret\" });", ""),
    ("rule9-depth-unbounded", V, "  if (depth >= VIEW_STATE_MAX_DEPTH) {\n    found.push({ path, kind: \"too-deep\" });\n    return found;\n  }\n", ""),
    ("open-instance-id-clash", G, "if (instanceOf(workspace, id) === undefined && freshId(workspace, id) === id) return id;", "return id;"),
    ("open-focus-not-given", G, "const next: SavedWorkspace = withFocus(", "const next: SavedWorkspace = ((kept: SavedWorkspace, _group: string) => kept)("),
    ("layout-collapsed-full-share", I, "    layout.regions[region].collapsed ? COLLAPSED_SHARE : Math.min(0.9, Math.max(layout.regions[region].size, COLLAPSED_SHARE));", "    Math.min(0.9, Math.max(layout.regions[region].size, COLLAPSED_SHARE));"),
    ("layout-columns-swapped", I, ROW, "  if (right !== undefined) row.push({ node: right, weight: rightShare });\n  if (centre !== undefined) row.push({ node: centre, weight: Math.max(MIN_CENTRE_SHARE, 1 - leftShare - rightShare) });\n  if (left !== undefined) row.push({ node: left, weight: leftShare });"),
    # each fix of the code review, taken back out
    ("fix1-group-move-root-id-clash", M, "    if (cleaned.root.kind === \"tabs\" && cleaned.root.id === source.id) {", "    if (false) {"),
    ("fix2-lone-group-id-clash", I, "id: unique(`${entry.panel}-group`)", "id: `${entry.panel}-group`"),
    ("fix2-column-id-clash", I, "id: unique(`${region}-column`)", "id: `${region}-column`"),
    ("fix2-root-id-clash", I, "id: unique(\"root\"), direction: \"vertical\"", "id: \"root\", direction: \"vertical\""),
    ("fix2-top-row-id-clash", I, "id: unique(\"top-row\")", "id: \"top-row\""),
    ("fix2-groups-not-reserved", I, "  for (const region of REGIONS) for (const group of layout.regions[region].groups) taken.add(group.id);\n", ""),
    ("fix3-instance-lookup-inherits", M, "return Object.prototype.hasOwnProperty.call(workspace.instances, instanceId) ? workspace.instances[instanceId] : undefined;", "return workspace.instances[instanceId];"),
    ("fix3-proto-instance-key-allowed", I, "      if (key === \"__proto__\") fail(\"instances.__proto__\", \"a panel id (this one is not allowed)\");\n", ""),
    ("fix3-alias-inherited", I, "(Object.prototype.hasOwnProperty.call(aliases, name) ? aliases[name] : undefined)", "aliases[name]"),
    ("fix4-key-contains-word", V, "  if (SECRET_LAST_WORD.has(last)) return true;", "  if (words.some((word) => SECRET_LAST_WORD.has(word))) return true;"),
    ("fix4-any-key-word", V, "return last === \"key\" && SECRET_BEFORE_KEY.has(words[words.length - 2] ?? \"\");", "return last === \"key\";"),
    ("fix4-camel-case-not-split", V, "    .replace(/([a-z0-9])([A-Z])/g, \"$1 $2\")\n", ""),
    ("fix5-value-any-length", V, "{8,})$/i;", "{1,})$/i;"),
    ("fix5-value-prefix-only", V, "const SECRET_VALUE = /^(gx1\\.\\S+|(bearer|basic)\\s+[A-Za-z0-9+/_.=~-]{8,})$/i;", "const SECRET_VALUE = /^(gx1\\.|bearer\\s|basic\\s)/i;"),
    ("fix6-centre-uses-stored-size", I, "weight: Math.max(MIN_CENTRE_SHARE, 1 - leftShare - rightShare) }", "weight: share(\"centre\") }"),
    ("fix6-centre-no-floor", I, "weight: Math.max(MIN_CENTRE_SHARE, 1 - leftShare - rightShare) }", "weight: 1 - leftShare - rightShare }"),
    ("fix6-timeline-share-swapped", I, "weights: normalizeWeights([1 - share(\"bottom\"), share(\"bottom\")]), children: [top, bottom] }", "weights: normalizeWeights([share(\"bottom\"), 1 - share(\"bottom\")]), children: [top, bottom] }"),
    ("fix6-timeline-above", I, "children: [top, bottom] }", "children: [bottom, top] }"),
    ("fix6-not-normalised", I, "  return normalizeWorkspace({\n    schemaVersion: WORKSPACE_SCHEMA_VERSION,", "  return ({\n    schemaVersion: WORKSPACE_SCHEMA_VERSION,"),
    ("fix7-move-keeps-hiding-maximise", M, "  return now === undefined ? placed : withFocus(placed, now.id);", "  return now === undefined ? placed : { ...placed, activeGroupId: now.id };"),
    ("fix7-group-move-keeps-hiding-maximise", M, "return findGroup(placed, target) === undefined ? placed : withFocus(placed, target);", "return findGroup(placed, target) === undefined ? placed : { ...placed, activeGroupId: target };"),
    ("fix8-too-deep-passed", V, "    found.push({ path, kind: \"too-deep\" });\n", ""),
    ("fix9-nan-index-allowed", M, "  if (index !== undefined && !Number.isFinite(index)) return refuse(\"INVALID_DOCK_TARGET\", \"a tab cannot be put at a place that is not a number\");\n", ""),
    ("fix10-empty-group-moved", M, "  if (source.panelInstanceIds.length === 0) return refuse(\"INVALID_DOCK_TARGET\", `group ${groupId} holds no panel, so there is nothing to move`);\n", ""),
    ("viewstate-secret-kept", G, "  if (found.length > 0) {\n    const problems = found.map(secretProblem);", "  if (false) {\n    const problems = found.map(secretProblem);"),
    ("viewstate-odd-key-allowed", G, "  if (key === \"__proto__\" || key === \"\") {", "  if (false) {"),
    ("viewstate-not-stored", G, "  return { ...workspace, viewState: { ...workspace.viewState, [key]: value } };", "  return workspace;"),
    ("viewstate-other-keys-lost", G, "  return { ...workspace, viewState: { ...workspace.viewState, [key]: value } };", "  return { ...workspace, viewState: { [key]: value } };"),
]

only = set(sys.argv[1:])
results = []
for name, path, old, new in MUTANTS:
    if only and name not in only:
        continue
    backup = path + ".mutbak"
    shutil.copyfile(path, backup)
    try:
        text = open(path, encoding="utf-8", newline="").read()
        crlf = "\r\n" in text
        o = old.replace("\n", "\r\n") if crlf else old
        n = new.replace("\n", "\r\n") if crlf else new
        if text.count(o) != 1:
            results.append((name, "NOT-APPLIED (pattern count %d)" % text.count(o)))
            continue
        open(path, "w", encoding="utf-8", newline="").write(text.replace(o, n))
        log = os.path.join(OUT, "mutdock_%s.log" % name)
        with open(log, "wb") as fh:
            rc = subprocess.run(TESTS, cwd=WT, stdout=fh, stderr=subprocess.STDOUT, timeout=300, shell=True).returncode
        body = open(log, "rb").read().decode("utf-8", "replace")
        if rc == 0:
            verdict = "SURVIVED"
        elif "error TS" in body or "SyntaxError" in body:
            verdict = "BUILD ERROR"
        else:
            failed = [l.strip()[:90] for l in body.splitlines() if "\u00d7" in l or " FAIL " in l]
            verdict = "KILLED by " + " | ".join(failed[:1])
        results.append((name, verdict))
    finally:
        shutil.copyfile(backup, path)
        os.remove(backup)
        print(results[-1] if results else "", flush=True)

print("---")
for name, verdict in results:
    print("%-36s %s" % (name, verdict.encode("ascii", "replace").decode("ascii")))
print("killed %d of %d" % (sum(1 for _, v in results if v.startswith("KILLED")), len(results)))
