import type Anthropic from '@anthropic-ai/sdk'
import type { PayloadFacts } from './classify.js'
import { architectInstructions, specSchema } from './architect-contract.js'
import { classifyPayload } from './classify.js'

export const MODEL = 'claude-opus-5'
export const EFFORT = 'xhigh'

const MAX_TOKENS = 64000
const TOOL = 'StructuredOutput'

export interface Capture {
  brief: string
  attempt: number
  model: string
  effort: string
  stopReason: string | null
  outputTokens: number | null
  raw: string
  streamError: string | null
  facts: PayloadFacts
}

export async function captureOnce(client: Anthropic, brief: { name: string, text: string }, attempt: number): Promise<Capture> {
  let raw = ''
  let stopReason: string | null = null
  let outputTokens: number | null = null
  let streamError: string | null = null

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { effort: EFFORT },
    system: architectInstructions(),
    tools: [{
      name: TOOL,
      description: 'Return the design spec.',
      input_schema: specSchema() as Anthropic.Tool['input_schema'],
      eager_input_streaming: true,
    }],
    tool_choice: { type: 'tool', name: TOOL },
    messages: [{ role: 'user', content: `${brief.text}\n\nReturn the design spec object.` }],
  })

  try {
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta')
        raw += event.delta.partial_json
      if (event.type === 'message_delta') {
        stopReason = event.delta.stop_reason ?? stopReason
        outputTokens = event.usage?.output_tokens ?? outputTokens
      }
    }
  }
  catch (error) {
    streamError = error instanceof Error ? error.message : String(error)
  }

  return {
    brief: brief.name,
    attempt,
    model: MODEL,
    effort: EFFORT,
    stopReason,
    outputTokens,
    raw,
    streamError,
    facts: classifyPayload(raw),
  }
}
