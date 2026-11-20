import { useMemo } from 'react'
import { ROOT } from '@/sdk'
import { useConversations, useDocOf } from '@/sdk'
import type { ConversationSummary } from '@/sdk'
import { WorkspacesDoc } from './refs.ts'
import type { Workspace, WorkspaceIndex } from './types.ts'

export type WorkspaceConversation = ConversationSummary & { workspace?: Workspace }
const none: WorkspaceIndex = {
  items: {},
  queue: [],
  landers: {},
  landerConversations: {},
  results: {},
}
export function useWorkspaces() {
  return useDocOf(ROOT, WorkspacesDoc, (index) => index?.items ?? none.items)
}
export function useWorkspace(conversation: number | undefined) {
  return useDocOf(ROOT, WorkspacesDoc, (index) =>
    conversation === undefined ? undefined : index?.items[String(conversation)],
  )
}
export function useWorkspaceIndex() {
  return useDocOf(ROOT, WorkspacesDoc) ?? none
}
export function useLanderQueue() {
  return useDocOf(ROOT, WorkspacesDoc, (index) => index?.queue ?? none.queue)
}
export function useWorkspaceConversations(): WorkspaceConversation[] {
  const records = useWorkspaces()
  const conversations = useConversations()
  return useMemo(
    () =>
      conversations.map((conversation) => ({
        ...conversation,
        workspace: records[String(conversation.id)],
      })),
    [conversations, records],
  )
}

export const stateLabel = (workspace: Workspace) =>
  ({ preparing: 'Setting up…', ready: 'Ready', failed: 'Setup failed', removed: 'Removed' })[
    workspace.state
  ]
