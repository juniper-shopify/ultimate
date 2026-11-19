import { ROOT } from './api.ts'
import { createSubscriptionLane } from './subscription-lane.ts'
import { parseConversationId } from '../../../lib/ids.ts'
import type { JsonObject, TaskGraph, ConversationId } from '@earendil-works/pi-durable'
import { applyImmutable } from '@earendil-works/chord/delta'
import { nextTurn, retryAfter } from '../../../lib/timers.ts'
import { keepLast, meansNone } from '../../../lib/errors.ts'
import type { Cancel } from '../../../lib/timers.ts'
import type { JsonValue } from '@earendil-works/chord/json'
import type {
  ConversationSummary,
  ModelsResponse,
  Notice,
  ServerEvents,
  StreamedView,
  SystemInfo,
} from '../../../shared/protocol.ts'

export interface Connection {
  /** `connecting` before the first open, `reconnecting` after a drop. */
  status: 'connecting' | 'open' | 'reconnecting'
  /** Epoch ms of the last status change. */
  since: number
}

export interface UiState {
  paletteOpen: boolean
  dialogs: Readonly<Record<string, boolean | undefined>>
  theme: 'dark' | 'light'
  surface?: { id: string; title: string }
  open?: Partial<Record<'phone' | 'tablet', { sidebar?: boolean; panels?: boolean }>>
}
type Docs = Readonly<Record<string, JsonObject | null>>
export interface State {
  connection: Connection
  /** The conversation the stream should show; the server's root when absent. */
  requested?: ConversationId
  /** The shown conversation's replica: snapshot plus every applied ops batch. */
  view?: StreamedView
  /** `view` is what this tab showed of the requested conversation before; its stream's snapshot replaces it. */
  restored?: boolean
  /** Replicas retained by `ConversationScope`, independent of the shown conversation. */
  viewsOf: Readonly<Record<number, StreamedView | undefined>>
  /** Extension documents of the shown conversation, by kind. */
  docs: Docs
  /** Extension documents of given conversations (`watchDocOf`), by conversation id, then kind. */
  docsOf: Readonly<Record<number, Docs>>
  /** The root conversation's `ultimate.ui` document, once streamed; read it through `uiState`. */
  shared?: Readonly<Record<string, JsonValue>>
  system?: SystemInfo
  conversations: readonly ConversationSummary[]
  tasks?: TaskGraph
  models?: ModelsResponse
  notices: readonly (Notice & { id: number; at: number })[]
  ui: UiState
}

export interface EventSourceLike {
  readonly readyState: number
  addEventListener(name: string, listener: (event: Event) => void): void
  close(): void
}
export interface StoreOptions {
  eventSource?: (url: string) => EventSourceLike
  fetch?: typeof fetch
  retryMs?: number
  onFallback?: () => void
  ui?: Partial<UiState>
}

const EVENT_SOURCE_CLOSED_NO_RETRY = 2
const STREAM_GONE_RECONNECT_RESUBSCRIBES = 410
const names = [
  'stream',
  'system',
  'conversations',
  'view',
  'ops',
  'ui',
  'uiOps',
  'doc',
  'docOps',
  'tasks',
  'notice',
] as const satisfies readonly (keyof ServerEvents)[]

const subscriptionIdPrefixedEvents = new Set<keyof ServerEvents>(['view', 'ops', 'doc', 'docOps'])
type Handler = (name: 'view' | 'ops' | 'doc' | 'docOps', raw: string) => void

type SubscriptionSpec = { conversation?: ConversationId; docs: string[]; view: boolean }
interface SubscriptionPost {
  controller: AbortController
  sent: boolean
  stream?: string
  spec: SubscriptionSpec
}
const backgroundSubscriptionRequestLimit = 4

interface DocStream {
  kinds: string
  view: boolean
  sub: number
  cancelRetry?: Cancel
}

function applyDoc(docs: Docs, event: ServerEvents['doc'] | ServerEvents['docOps']): Docs {
  if ('value' in event) return { ...docs, [event.kind]: event.value }
  const subscriptionSnapshot = docs[event.kind]
  if (subscriptionSnapshot === undefined) return docs
  return { ...docs, [event.kind]: applyImmutable(subscriptionSnapshot ?? {}, event.ops) }
}

export function createStore(options: StoreOptions = {}) {
  const open = options.eventSource ?? ((url: string) => new EventSource(url))
  const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  let state: State = {
    connection: { status: 'connecting', since: Date.now() },
    viewsOf: {},
    docs: {},
    docsOf: {},
    conversations: [],
    notices: [],
    ui: {
      paletteOpen: false,
      dialogs: {},
      theme: 'dark',
      ...options.ui,
    },
  }
  const listeners = new Set<() => void>()
  const docKinds = new Map<string, number>()
  let mainDocKinds = new Set<string>()

  const docWatchCountsByConversation = new Map<ConversationId, Map<string, number>>()
  const watchedViews = new Map<ConversationId, number>()

  const sharedSubscriptionsByConversation = new Map<ConversationId, DocStream>()

  let multiplexedEventSource: EventSourceLike | undefined

  let streamId: string | undefined
  const handlers = new Map<number, Handler>()
  const pendingSubscriptions = new Map<number, Promise<void>>()
  const subscriptionPosts = new Map<number, SubscriptionPost>()
  const subscriptionLane = createSubscriptionLane(backgroundSubscriptionRequestLimit)
  let subscriptionController = new AbortController()
  let nextSub = 0
  let main: number | undefined
  let opened = false
  let cancelRetry: Cancel | undefined
  let cancelResubscribe: Cancel | undefined
  let cancelSync: Cancel | undefined
  let noticeId = 0
  let stopped = true

  const recentViewsWithRawSnapshots = new Map<
    ConversationId,
    { view: StreamedView; raw?: string }
  >()
  const retainedConversationLimit = 6

  const lastWholeStateEventText: Partial<Record<keyof ServerEvents, string>> = {}
  const snapshots = new Set<keyof ServerEvents>(['system', 'conversations', 'tasks'])
  function remember(view: StreamedView, raw?: string) {
    const id = view.conversation.id
    recentViewsWithRawSnapshots.delete(id)
    recentViewsWithRawSnapshots.set(id, { view, raw })
    if (recentViewsWithRawSnapshots.size > retainedConversationLimit)
      recentViewsWithRawSnapshots.delete(recentViewsWithRawSnapshots.keys().next().value!)
  }

  function set(change: Partial<State>) {
    state = { ...state, ...change }
    for (const listener of listeners) listener()
  }
  function setConnection(status: Connection['status']) {
    if (state.connection.status !== status) set({ connection: { status, since: Date.now() } })
  }

  function handle(name: keyof ServerEvents, data: unknown) {
    switch (name) {
      case 'stream':
      case 'view':
        break
      case 'system': {
        const system = data as SystemInfo
        const restarted =
          state.system &&
          (state.system.process.pid !== system.process.pid ||
            state.system.process.generation !== system.process.generation)
        set({ system })
        if (!state.models || restarted) void refreshModels()
        break
      }
      case 'conversations': {
        const previous = new Map(state.conversations.map((summary) => [summary.id, summary]))
        const conversations = (data as ServerEvents['conversations']).map((summary) => {
          const kept = previous.get(summary.id)
          const unchangedRowKeepsIdentity = kept && JSON.stringify(kept) === JSON.stringify(summary)
          return unchangedRowKeepsIdentity ? kept : summary
        })
        set({ conversations })
        break
      }
      case 'ops':
        if (state.view) {
          const view = applyImmutable(state.view, data as ServerEvents['ops'])
          remember(view)
          set({ view })
        }
        break
      case 'ui':
        set({ shared: (data as ServerEvents['ui']).value })
        break
      case 'uiOps':
        if (state.shared)
          set({
            shared: applyImmutable(state.shared, (data as ServerEvents['uiOps']).ops),
          })
        break
      case 'doc':
      case 'docOps': {
        const event = data as ServerEvents['doc'] | ServerEvents['docOps']
        if (!mainDocKinds.has(event.kind)) break
        const docs = applyDoc(state.docs, event)
        if (docs !== state.docs) set({ docs })
        break
      }
      case 'tasks':
        set({ tasks: data as TaskGraph })
        break
      case 'notice':
        set({
          notices: [
            ...state.notices.slice(-49),
            { ...(data as Notice), id: ++noticeId, at: Date.now() },
          ],
        })
        break
    }
  }

  function replaceViewFromFreshSnapshot(raw: string) {
    const kept =
      state.requested === undefined ? undefined : recentViewsWithRawSnapshots.get(state.requested)
    if (kept && kept.raw === raw && state.view === kept.view) {
      if (state.restored) set({ restored: false })
      return
    }
    const view = JSON.parse(raw) as StreamedView
    remember(view, raw)
    set({ view, restored: false })
  }

  function subscribe(spec: SubscriptionSpec, handler: Handler, failed: (status: number) => void) {
    const sub = ++nextSub
    handlers.set(sub, handler)
    subscriptionPosts.set(sub, { controller: new AbortController(), sent: false, spec })
    updateSubscription(sub, spec, failed)
    return sub
  }
  function updateSubscription(
    sub: number,
    spec: SubscriptionSpec,
    failed: (status: number) => void,
  ) {
    const stream = streamId
    if (stream === undefined) return
    const post = subscriptionPosts.get(sub)!
    const wasInteractive = interactiveSubscription(post.spec)
    post.spec = spec
    if (!wasInteractive && interactiveSubscription(spec)) subscriptionLane.promote()
    const signal = AbortSignal.any([post.controller.signal, subscriptionController.signal])
    const refused = (status: number) => {
      if (!signal.aborted && handlers.has(sub) && streamId === stream) failed(status)
    }
    const send = () => {
      if (!handlers.has(sub) || streamId !== stream) return Promise.resolve()
      return subscriptionLane
        .run(
          async () => {
            if (!handlers.has(sub) || streamId !== stream) return
            post.sent = true
            post.stream = stream
            const response = await request(`/api/events/${stream}/${sub}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(spec),
              signal,
            })
            await response.text()
            if (!response.ok) refused(response.status)
          },
          () => interactiveSubscription(post.spec),
          signal,
        )
        .catch(() => refused(0))
    }
    const pending = pendingSubscriptions.get(sub)
    pendingSubscriptions.set(sub, pending ? pending.then(send) : send())
  }
  function interactiveSubscription(spec: SubscriptionSpec) {
    return (
      spec.view ||
      spec.conversation === ROOT ||
      spec.conversation === (state.requested ?? state.view?.conversation.id)
    )
  }
  function resetSubscriptionRequests() {
    subscriptionController.abort()
    subscriptionController = new AbortController()
    subscriptionPosts.clear()
    pendingSubscriptions.clear()
  }
  function unsubscribe(sub: number | undefined) {
    if (sub === undefined) return
    const post = subscriptionPosts.get(sub)
    subscriptionPosts.delete(sub)
    pendingSubscriptions.delete(sub)
    const watched = handlers.delete(sub)
    post?.controller.abort()
    if (!watched || streamId === undefined || !post?.sent) return
    const signal = subscriptionController.signal
    subscriptionLane
      .run(
        async () => {
          const response = await request(`/api/events/${post.stream}/${sub}`, {
            method: 'DELETE',
            signal,
          })
          await response.text()
        },
        () => interactiveSubscription(post.spec),
        signal,
      )
      .catch(meansNone)
  }

  function openMain() {
    unsubscribe(main)
    main = undefined
    syncMain()
  }
  function syncMain() {
    cancelResubscribe?.()
    mainDocKinds = new Set(docKinds.keys())
    if (Object.keys(state.docs).some((kind) => !mainDocKinds.has(kind)))
      set({
        docs: Object.fromEntries(
          Object.entries(state.docs).filter(([kind]) => mainDocKinds.has(kind)),
        ),
      })
    const spec = {
      conversation: state.requested,
      docs: [...mainDocKinds].toSorted(),
      view: true,
    }
    if (main !== undefined) {
      updateSubscription(main, spec, retryMain)
      return
    }
    main = subscribe(
      spec,
      (name, raw) =>
        name === 'view' ? replaceViewFromFreshSnapshot(raw) : handle(name, JSON.parse(raw)),
      retryMain,
    )
  }
  function retryMain(status: number) {
    if (status === STREAM_GONE_RECONNECT_RESUBSCRIBES) return
    cancelResubscribe?.()
    const requestedConversationNeverOpened =
      status === 404 && state.requested !== undefined && !state.view
    if (requestedConversationNeverOpened) {
      set({ requested: undefined })
      options.onFallback?.()
      openMain()
    } else cancelResubscribe = retryAfter(options.retryMs ?? 1000, openMain)
  }

  function connect() {
    cancelRetry?.()
    multiplexedEventSource?.close()
    streamId = undefined
    resetSubscriptionRequests()
    const current = open('/api/events')
    multiplexedEventSource = current
    opened = false
    current.addEventListener('open', () => {
      if (multiplexedEventSource !== current) return
      opened = true
      setConnection('open')
    })
    current.addEventListener('error', () => {
      if (multiplexedEventSource !== current) return
      streamId = undefined
      resetSubscriptionRequests()
      setConnection(opened || state.view ? 'reconnecting' : 'connecting')

      if (current.readyState === EVENT_SOURCE_CLOSED_NO_RETRY)
        cancelRetry = retryAfter(options.retryMs ?? 1000, connect)
    })
    for (const name of names)
      current.addEventListener(name, (event) => {
        if (multiplexedEventSource !== current) return
        const raw = (event as MessageEvent<string>).data
        if (subscriptionIdPrefixedEvents.has(name)) {
          const cut = raw.indexOf('\n')
          handlers.get(Number(raw.slice(0, cut)))?.(
            name as Parameters<Handler>[0],
            raw.slice(cut + 1),
          )
        } else if (name === 'stream') {
          streamId = (JSON.parse(raw) as ServerEvents['stream']).id
          handlers.clear()
          resetSubscriptionRequests()
          openMain()

          const subscriptionsBeforeReopen = Array.from(sharedSubscriptionsByConversation)
          for (const [conversation, stream] of subscriptionsBeforeReopen)
            openDocs(conversation, stream.kinds, stream.view)
        } else if (snapshots.has(name)) {
          if (lastWholeStateEventText[name] !== raw) {
            lastWholeStateEventText[name] = raw
            handle(name, JSON.parse(raw))
          } else if (name === 'system' && !state.models) void refreshModels()
        } else handle(name, JSON.parse(raw))
      })
  }
  function scheduleMain() {
    if (stopped) return
    cancelResubscribe?.()
    cancelResubscribe = nextTurn(syncMain)
  }

  function openDocs(conversation: ConversationId, kinds: string, withView: boolean) {
    closeDocs(conversation)
    const stream: DocStream = { kinds, view: withView, sub: 0 }
    sharedSubscriptionsByConversation.set(conversation, stream)
    stream.sub = subscribe(
      { conversation, docs: kinds ? kinds.split(',') : [], view: withView },
      (name, raw) => {
        const data = JSON.parse(raw)
        if (name === 'view' || name === 'ops') {
          if (!watchedViews.has(conversation)) return
          const current = state.viewsOf[conversation]
          const view =
            name === 'view'
              ? (data as StreamedView)
              : current && applyImmutable(current, data as ServerEvents['ops'])
          if (view) set({ viewsOf: { ...state.viewsOf, [conversation]: view } })
          return
        }
        const change = data as ServerEvents['doc'] | ServerEvents['docOps']
        if (!docWatchCountsByConversation.get(conversation)?.has(change.kind)) return
        const docs = state.docsOf[conversation] ?? {}
        const next = applyDoc(docs, change)
        if (next !== docs) set({ docsOf: { ...state.docsOf, [conversation]: next } })
      },
      (status) => retryDocs(conversation, stream, status),
    )
  }
  function retryDocs(conversation: ConversationId, stream: DocStream, status: number) {
    if (status === STREAM_GONE_RECONNECT_RESUBSCRIBES) return
    stream.cancelRetry?.()
    stream.cancelRetry = retryAfter(options.retryMs ?? 1000, () =>
      openDocs(conversation, stream.kinds, stream.view),
    )
  }
  function closeDocs(conversation: ConversationId) {
    const stream = sharedSubscriptionsByConversation.get(conversation)
    unsubscribe(stream?.sub)
    stream?.cancelRetry?.()
    sharedSubscriptionsByConversation.delete(conversation)
  }

  function syncSharedViewAndDocSubscriptions() {
    const conversations = new Set([...docWatchCountsByConversation.keys(), ...watchedViews.keys()])
    for (const conversation of sharedSubscriptionsByConversation.keys())
      if (!conversations.has(conversation)) closeDocs(conversation)
    const docsOf: Record<number, Docs> = {}
    for (const conversation of conversations) {
      const kinds = docWatchCountsByConversation.get(conversation) ?? new Map<string, number>()
      const list = [...kinds.keys()].toSorted().join(',')
      const stream = sharedSubscriptionsByConversation.get(conversation)
      const view = watchedViews.has(conversation)

      if (!stream) openDocs(conversation, list, view)
      else if (stream.kinds !== list || stream.view !== view) {
        stream.kinds = list
        stream.view = view
        updateSubscription(
          stream.sub,
          { conversation, docs: [...kinds.keys()].toSorted(), view },
          (status) => retryDocs(conversation, stream, status),
        )
      }

      const current = state.docsOf[conversation] ?? {}
      docsOf[conversation] = Object.keys(current).every((kind) => kinds.has(kind))
        ? current
        : Object.fromEntries(Object.entries(current).filter(([kind]) => kinds.has(kind)))
    }
    const viewsOf = Object.fromEntries(
      Object.entries(state.viewsOf).filter(([id]) =>
        watchedViews.has(parseConversationId(Number(id))),
      ),
    )
    set({ docsOf, viewsOf })
  }
  function scheduleSync() {
    if (stopped) return
    cancelSync?.()
    cancelSync = nextTurn(syncSharedViewAndDocSubscriptions)
  }

  async function refreshModels() {
    try {
      const response = await request('/api/models')
      if (response.ok) set({ models: (await response.json()) as ModelsResponse })
    } catch (error) {
      keepLast(error)
    }
  }

  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start() {
      if (!stopped) return
      stopped = false
      connect()
      syncSharedViewAndDocSubscriptions()
    },
    stop() {
      stopped = true
      cancelRetry?.()
      cancelResubscribe?.()
      cancelSync?.()

      streamId = undefined
      resetSubscriptionRequests()
      for (const conversation of sharedSubscriptionsByConversation.keys()) closeDocs(conversation)
      unsubscribe(main)
      main = undefined
      multiplexedEventSource?.close()
      multiplexedEventSource = undefined
    },

    show(id: ConversationId | undefined) {
      if (id === state.requested) return
      unsubscribe(main)
      main = undefined
      const kept = id === undefined ? undefined : recentViewsWithRawSnapshots.get(id)?.view
      set({
        requested: id,
        view: kept,
        restored: kept !== undefined,
        docs: {},
      })
      subscriptionLane.promote()
      scheduleMain()
    },

    watchConversation(id: ConversationId) {
      watchedViews.set(id, (watchedViews.get(id) ?? 0) + 1)
      scheduleSync()
      return () => {
        const left = (watchedViews.get(id) ?? 1) - 1
        if (left > 0) watchedViews.set(id, left)
        else watchedViews.delete(id)
        scheduleSync()
      }
    },

    watchDoc(kind: string) {
      const count = docKinds.get(kind) ?? 0
      docKinds.set(kind, count + 1)
      if (count === 0) scheduleMain()
      return () => {
        const left = (docKinds.get(kind) ?? 1) - 1
        if (left > 0) docKinds.set(kind, left)
        else {
          docKinds.delete(kind)
          scheduleMain()
        }
      }
    },

    watchDocOf(conversation: ConversationId, kind: string) {
      const kinds = docWatchCountsByConversation.get(conversation) ?? new Map<string, number>()
      docWatchCountsByConversation.set(conversation, kinds)
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
      scheduleSync()
      return () => {
        const left = (kinds.get(kind) ?? 1) - 1
        if (left > 0) kinds.set(kind, left)
        else kinds.delete(kind)
        if (!kinds.size) docWatchCountsByConversation.delete(conversation)
        scheduleSync()
      }
    },
    refreshModels,
    setUi(change: Partial<UiState>) {
      set({ ui: { ...state.ui, ...change } })
    },

    notify(notice: Notice) {
      handle('notice', notice)
    },
    dismissNotice(id: number) {
      set({ notices: state.notices.filter((notice) => notice.id !== id) })
    },
  }
}
export type Store = ReturnType<typeof createStore>
