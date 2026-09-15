import { SendMailbox } from '../src/send-mailbox.mjs'

const [rootDir, target] = process.argv.slice(2)
const mailbox = new SendMailbox({ rootDir })

await mailbox.run(target, 'crash-child', { text: 'once' }, async dispatch => {
  await dispatch({ conversationId: 'conv-crash', turnId: 'turn-crash' })
  process.stdout.write('DISPATCHED\n')
  await new Promise(() => {})
})
