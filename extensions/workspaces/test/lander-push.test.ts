import { withAbortSignal } from '@earendil-works/chord/context'
import { afterEach, expect, it, vi } from 'vitest'
import { context } from '../../../server/harness.ts'
import { runGroup } from '../../../lib/process-group.ts'
import { checkPids, runLanderPush } from '../lander.ts'

vi.mock('../../../lib/process-group.ts', () => ({ runGroup: vi.fn<typeof runGroup>() }))

afterEach(() => {
  vi.resetAllMocks()
  vi.useRealTimers()
})

function hanging() {
  vi.useFakeTimers()
  vi.mocked(runGroup).mockImplementation(async (_program, _args, options) => {
    options.onOutput('remote rejected the update')
    if (!options.signal!.aborted)
      await new Promise<void>((resolve) =>
        options.signal!.addEventListener('abort', () => resolve(), { once: true }),
      )
    return { code: 137, outOfMemory: false }
  })
}

it('pushes the supplied commit, not the current branch, and registers the process for recovery', async () => {
  vi.useFakeTimers()
  vi.mocked(runGroup).mockResolvedValue({ code: 0, outOfMemory: false })
  await runLanderPush('/source', 'origin', 'checked-sha', 'main', context, '/state')
  const [program, args, options] = vi.mocked(runGroup).mock.calls[0]
  expect(program).toBe('git')
  expect(args).toEqual(['push', '-q', 'origin', 'checked-sha:refs/heads/main'])
  expect(options.cwd).toBe('/source')
  expect(options.pidFile).toContain(checkPids('/state'))
  expect(options.grace).toBe(2000)
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels the push with its caller and clears the deadline', async () => {
  hanging()
  const controller = new AbortController()
  const pushed = runLanderPush(
    '/source',
    'origin',
    'checked-sha',
    'main',
    withAbortSignal(controller.signal, context),
    '/state',
  )
  const stopped = pushed.catch((error: unknown) => error)
  controller.abort(new Error('cancelled by caller'))
  expect(await stopped).toMatchObject({ message: 'cancelled by caller' })
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds push duration and retains the remote error in the timeout', async () => {
  hanging()
  const pushed = runLanderPush('/source', 'origin', 'checked-sha', 'main', context, '/state', 100)
  const stopped = pushed.catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(100)
  expect(await stopped).toMatchObject({
    message: 'Push timed out after 0.1 s:\nremote rejected the update',
  })
  expect(vi.getTimerCount()).toBe(0)
})
