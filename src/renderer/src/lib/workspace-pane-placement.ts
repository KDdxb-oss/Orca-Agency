import {
  collectWorkspaceIds,
  findWorkspaceSplitGroup,
  placeWorkspaceAtEdge,
  type WorkspaceLayoutNode,
  type WorkspaceSplitGroup
} from './workspace-split-layout'

export type WorkspaceQuadrant = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export type WorkspacePanePlacement =
  | { kind: 'swap' }
  | { kind: 'quadrant'; quadrant: WorkspaceQuadrant }

const quadrants: WorkspaceQuadrant[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
const leaf = (workspaceId: string): WorkspaceLayoutNode => ({ type: 'leaf', workspaceId })
const pair = (
  direction: 'horizontal' | 'vertical',
  first: WorkspaceLayoutNode | undefined,
  second: WorkspaceLayoutNode | undefined
): WorkspaceLayoutNode | undefined =>
  first && second ? { type: 'split', direction, first, second, ratio: 0.5 } : (first ?? second)

function centers(
  node: WorkspaceLayoutNode,
  bounds = { left: 0, top: 0, width: 1, height: 1 },
  result = new Map<string, { x: number; y: number }>()
) {
  if (node.type === 'leaf') {
    result.set(node.workspaceId, {
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2
    })
  } else if (node.direction === 'horizontal') {
    centers(node.first, { ...bounds, width: bounds.width * node.ratio }, result)
    centers(
      node.second,
      {
        ...bounds,
        left: bounds.left + bounds.width * node.ratio,
        width: bounds.width * (1 - node.ratio)
      },
      result
    )
  } else {
    centers(node.first, { ...bounds, height: bounds.height * node.ratio }, result)
    centers(
      node.second,
      {
        ...bounds,
        top: bounds.top + bounds.height * node.ratio,
        height: bounds.height * (1 - node.ratio)
      },
      result
    )
  }
  return result
}

/** Exchange occupied slots without changing split sizes or touching their terminals. */
export function placeWorkspacePane(
  groups: readonly WorkspaceSplitGroup[],
  source: string,
  target: string,
  placement: WorkspacePanePlacement,
  newGroupId: string
): WorkspaceSplitGroup[] {
  const destination = findWorkspaceSplitGroup(groups, target)
  if (!source || !destination) {
    return [...groups]
  }
  if (placement.kind === 'swap') {
    if (source === target || !collectWorkspaceIds(destination.layout).includes(source)) {
      return [...groups]
    }
    const swap = (node: WorkspaceLayoutNode): WorkspaceLayoutNode =>
      node.type === 'leaf'
        ? leaf(
            node.workspaceId === source
              ? target
              : node.workspaceId === target
                ? source
                : node.workspaceId
          )
        : { ...node, first: swap(node.first), second: swap(node.second) }
    return groups.map((group) =>
      group.id === destination.id ? { ...group, layout: swap(group.layout) } : group
    )
  }
  const moved = collectWorkspaceIds(destination.layout).includes(source)
    ? [...groups]
    : placeWorkspaceAtEdge(groups, source, target, 'right', newGroupId)
  const group = findWorkspaceSplitGroup(moved, target)
  if (!group || !collectWorkspaceIds(group.layout).includes(source)) {
    return [...groups]
  }
  const members = collectWorkspaceIds(group.layout).filter((id) => id !== source)
  if (members.length < 2) {
    return placeWorkspaceAtEdge(
      groups,
      source,
      target,
      placement.quadrant.endsWith('right') ? 'right' : 'left',
      newGroupId
    )
  }
  const original = centers(destination.layout)
  const bins = new Map<WorkspaceQuadrant, string[]>(quadrants.map((quadrant) => [quadrant, []]))
  bins.get(placement.quadrant)!.push(source)
  const available = quadrants.filter((quadrant) => quadrant !== placement.quadrant)
  const firstCenter = original.get(members[0])!
  const secondCenter = original.get(members[1])!
  const rowsFirst =
    members.length === 2 &&
    Math.abs(firstCenter.y - secondCenter.y) > Math.abs(firstCenter.x - secondCenter.x)
  // Preserve the untouched half when three panes occupy one row or column pair.
  const partner = available.find((quadrant) =>
    rowsFirst
      ? quadrant.split('-')[0] === placement.quadrant.split('-')[0]
      : quadrant.split('-')[1] === placement.quadrant.split('-')[1]
  )!
  const distanceFrom = (id: string, quadrant: WorkspaceQuadrant) => {
    const center = original.get(id) ?? { x: 0.5, y: 0.5 }
    return (
      Math.abs(center.x - (quadrant.endsWith('left') ? 0.25 : 0.75)) +
      Math.abs(center.y - (quadrant.startsWith('top') ? 0.25 : 0.75))
    )
  }
  if (members.length === 2) {
    available.splice(available.indexOf(partner), 1)
    available.unshift(partner)
    members.sort((a, b) => distanceFrom(a, partner) - distanceFrom(b, partner))
  }
  if (members.length === 3) {
    const assignments = available.flatMap((first) =>
      available
        .filter((second) => second !== first)
        .map((second) => [
          first,
          second,
          available.find((third) => third !== first && third !== second)!
        ])
    )
    const cost = (assignment: WorkspaceQuadrant[]) =>
      assignment.reduce((sum, quadrant, index) => sum + distanceFrom(members[index], quadrant), 0)
    const best = assignments.reduce((best, next) => (cost(next) < cost(best) ? next : best))
    members.forEach((id, index) => bins.get(best[index])!.push(id))
  }
  for (const id of members.length === 3 ? [] : members) {
    const empty = available.filter((quadrant) => bins.get(quadrant)!.length === 0)
    const candidates =
      members.length === 2 && empty.includes(partner) ? [partner] : empty.length ? empty : available
    const distance = (quadrant: WorkspaceQuadrant) => distanceFrom(id, quadrant)
    const selected = candidates.reduce((best, next) =>
      distance(next) < distance(best) ? next : best
    )
    bins.get(selected)!.push(id)
  }
  const slot = (quadrant: WorkspaceQuadrant) =>
    bins
      .get(quadrant)!
      .map(leaf)
      .reduce<WorkspaceLayoutNode | undefined>(
        (node, next) => pair('vertical', node, next),
        undefined
      )
  const layout = rowsFirst
    ? pair(
        'vertical',
        pair('horizontal', slot('top-left'), slot('top-right')),
        pair('horizontal', slot('bottom-left'), slot('bottom-right'))
      )!
    : pair(
        'horizontal',
        pair('vertical', slot('top-left'), slot('bottom-left')),
        pair('vertical', slot('top-right'), slot('bottom-right'))
      )!
  return moved.map((item) => (item.id === group.id ? { ...item, layout } : item))
}
