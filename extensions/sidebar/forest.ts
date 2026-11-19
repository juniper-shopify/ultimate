type Conversation = {
  id: number
  parentConversationId?: number
  ownerTaskId?: unknown
  branchOf?: { conversationId: number }
  busy: boolean
  inputAt?: number
}

export const newestInputFirst = (a: Conversation, b: Conversation) =>
  (b.inputAt ?? 0) - (a.inputAt ?? 0) || b.id - a.id

export function sidebarForest<T extends Conversation>(
  conversations: readonly T[],
  roots: ReadonlySet<number>,
) {
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]))
  const childrenByParent = new Map<number, T[]>()
  const descendants = new Map<number, number[]>()
  const branchesBySource = new Map<number, T[]>()
  for (const conversation of conversations) {
    const parent = conversation.parentConversationId
    if (parent !== undefined && conversation.ownerTaskId !== undefined) {
      const children = childrenByParent.get(parent) ?? []
      children.push(conversation)
      childrenByParent.set(parent, children)
    }
    const source = parent ?? conversation.branchOf?.conversationId
    if (source !== undefined) {
      const children = descendants.get(source) ?? []
      children.push(conversation.id)
      descendants.set(source, children)
    }
  }
  for (const conversation of conversations.toSorted(newestInputFirst)) {
    const source = conversation.branchOf?.conversationId
    if (source === undefined || roots.has(conversation.id)) continue
    const branches = branchesBySource.get(source) ?? []
    branches.push(conversation)
    branchesBySource.set(source, branches)
  }
  const tops = new Map<number, T | undefined>()
  for (const conversation of conversations) {
    let current: T | undefined = conversation
    const path: number[] = []
    while (current && !tops.has(current.id)) {
      path.push(current.id)
      if (current.parentConversationId === undefined) break
      current = byId.get(current.parentConversationId)
    }
    const top = current && (tops.has(current.id) ? tops.get(current.id) : current)
    for (const id of path) tops.set(id, top)
  }
  const working = new Map<number, 'self' | 'subagents'>()
  for (const conversation of conversations) {
    if (
      !conversation.busy ||
      (conversation.parentConversationId !== undefined && conversation.ownerTaskId === undefined)
    )
      continue
    const top = tops.get(conversation.id)
    if (top)
      working.set(
        top.id,
        top.id === conversation.id ? 'self' : (working.get(top.id) ?? 'subagents'),
      )
  }
  const hiddenIds = (concluded: readonly number[]) => {
    const hidden = new Set(concluded)
    const pending = [...hidden]
    for (let index = 0; index < pending.length; index++) {
      for (const child of descendants.get(pending[index]) ?? []) {
        if (hidden.has(child)) continue
        hidden.add(child)
        pending.push(child)
      }
    }
    return hidden
  }
  return { byId, tops, childrenByParent, branchesBySource, working, hiddenIds }
}

export function withoutListedSource<T extends Conversation>(conversations: readonly T[]) {
  const ids = new Set(conversations.map((conversation) => conversation.id))
  return conversations.filter(
    (conversation) => !ids.has(conversation.branchOf?.conversationId ?? -1),
  )
}
