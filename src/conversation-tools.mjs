export const CONVERSATION_TOOLS = [
  { name: 'project_create', description: 'Create one ChatGPT Project through the signed-in web UI.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } },
  { name: 'project_find', description: 'Find an already-visible ChatGPT Project without navigation.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } },
  { name: 'project_pin', description: 'Persist a default ChatGPT Project destination.', inputSchema: { type: 'object', properties: { project_url: { type: 'string' } }, required: ['project_url'], additionalProperties: false } },
  { name: 'conversation_create', description: 'Create a managed conversation, optionally inside a Project.', inputSchema: { type: 'object', properties: { project_url: { type: 'string' } }, additionalProperties: false } },
  { name: 'conversation_send', description: 'Submit one prompt; return after acceptance while monitoring continues.', inputSchema: { type: 'object', properties: { conversation_id: { type: 'string' }, text: { type: 'string' } }, required: ['conversation_id', 'text'], additionalProperties: false } },
  { name: 'conversation_read', description: 'Read durable conversation state and response from the local ledger.', inputSchema: { type: 'object', properties: { conversation_id: { type: 'string' } }, required: ['conversation_id'], additionalProperties: false } }
]

export function dispatchConversationTool(host, name, args = {}) {
  const descriptor = CONVERSATION_TOOLS.find((tool) => tool.name === name)
  if (!descriptor) throw new TypeError(`Unknown tool: ${name}`)
  for (const key of descriptor.inputSchema.required ?? []) {
    if (typeof args[key] !== 'string') throw new TypeError(`${name} requires ${key}`)
  }
  if (name === 'project_create') return host.createProject(args.name)
  if (name === 'project_find') return host.findProject(args.name)
  if (name === 'project_pin') return host.pinProject(args.project_url)
  if (name === 'conversation_create') return host.create({ projectUrl: args.project_url })
  if (name === 'conversation_send') return host.send(args.conversation_id, args.text)
  return host.read(args.conversation_id)
}
