import { defineDoc, defineExtension, defineTool } from '@earendil-works/pi-durable'
import { obj } from '@earendil-works/pi-schema'
import { setTimeout } from 'node:timers/promises'

const Progress = defineDoc<{ pulses: number }>({
  kind: 'fleet.progress',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({ pulses: 0 }),
})
export const docs = [Progress]

export default defineExtension({
  name: 'fleet-probe',
  tools: [
    defineTool({
      name: 'fleet_pulse',
      description: 'Read the next synthetic sample.',
      parameters: obj({}),
      replay: 'safe',
      async execute(_args, api, context) {
        await setTimeout(250)
        await api.commit(async (tx) => {
          ;(await tx.doc(Progress, api.conversationId)).pulses++
        }, context)
        return { output: [{ type: 'text', text: 'Synthetic sample. '.repeat(256) }] }
      },
    }),
  ],
})
