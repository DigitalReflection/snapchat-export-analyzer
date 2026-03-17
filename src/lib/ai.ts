import type { AIResult, AISettings, WorkspaceDataset } from '../types'

function buildContext(workspace: WorkspaceDataset) {
  return {
    uploads: workspace.uploads.map((upload) => ({
      id: upload.id,
      fileName: upload.fileName,
      account: upload.account,
      categoryCounts: upload.categoryCounts,
    })),
    stats: workspace.stats,
    factsSummary: workspace.factsSummary,
    topContacts: workspace.contacts.slice(0, 8),
    topEntities: workspace.entities.slice(0, 12),
    toneSummaries: workspace.toneSummaries.slice(0, 8),
    repeatedPhrases: workspace.repeatedPhrases.slice(0, 8),
    signals: workspace.signals.slice(0, 10),
    notablePeriods: workspace.notablePeriods,
    evidence: workspace.evidenceSnippets.slice(0, 12).map((snippet) => ({
      id: snippet.eventId,
      timestamp: snippet.timestamp,
      label: snippet.label,
      sourceFile: snippet.sourceFile,
      excerpt: snippet.excerpt,
    })),
  }
}

function buildPrompt(workspace: WorkspaceDataset, question: string) {
  const context = JSON.stringify(buildContext(workspace), null, 2)

  return [
    'You are reviewing communication analytics data.',
    'Stay neutral, factual, and evidence-based.',
    'Do not infer intent beyond observed patterns.',
    'Use citations in square brackets with event IDs when referencing evidence.',
    'Structure the answer with these sections: Facts, Patterns, Tone categories, Notable periods, Follow-up questions.',
    '',
    `User question: ${question}`,
    '',
    'Grounding data:',
    context,
  ].join('\n')
}

function chunkChatEvents(workspace: WorkspaceDataset, maxChars = 18000) {
  const chatEvents = workspace.events.filter((event) => event.category === 'chat')
  const chunks: string[] = []
  let current = ''

  chatEvents.forEach((event) => {
    const line = [
      `[${event.id}]`,
      event.timestamp ?? 'unknown-time',
      event.contact ?? 'unknown-contact',
      event.text ?? event.detail ?? event.evidenceText,
    ].join(' | ')

    if ((current + line).length > maxChars && current) {
      chunks.push(current)
      current = line
      return
    }

    current = current ? `${current}\n${line}` : line
  })

  if (current) {
    chunks.push(current)
  }

  return chunks
}

function buildChunkPrompt(question: string, chunk: string, index: number, total: number) {
  return [
    'You are analyzing one chunk of chat messages from a communication intelligence dashboard.',
    'Stay factual and evidence-based.',
    'Do not speculate about intent.',
    'Return bullet-style short findings with citations using event IDs.',
    `Chunk ${index + 1} of ${total}.`,
    `Question: ${question}`,
    '',
    'Chat chunk:',
    chunk,
  ].join('\n')
}

function buildSynthesisPrompt(
  workspace: WorkspaceDataset,
  question: string,
  chunkFindings: string[],
) {
  return [
    buildPrompt(workspace, question),
    '',
    'Chunk-level findings:',
    chunkFindings.map((finding, index) => `Chunk ${index + 1}:\n${finding}`).join('\n\n'),
    '',
    'Produce a final answer that merges the deterministic context and the chunk-level findings.',
  ].join('\n')
}

function extractOpenAIText(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return ''
  }

  const response = payload as {
    output?: Array<{
      content?: Array<{ type?: string; text?: string }>
    }>
  }

  return (
    response.output
      ?.flatMap((item) => item.content ?? [])
      .map((part) => part.text ?? '')
      .join('\n')
      .trim() ?? ''
  )
}

function extractGeminiText(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return ''
  }

  const response = payload as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>
      }
    }>
  }

  return (
    response.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? '')
      .join('\n')
      .trim() ?? ''
  )
}

async function runOpenAI(settings: AISettings, prompt: string) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      input: prompt,
    }),
  })

  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${response.status} ${response.statusText}`)
  }

  const payload = await response.json()
  return extractOpenAIText(payload)
}

async function runGemini(settings: AISettings, prompt: string) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': settings.apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
      }),
    },
  )

  if (!response.ok) {
    throw new Error(`Gemini request failed: ${response.status} ${response.statusText}`)
  }

  const payload = await response.json()
  return extractGeminiText(payload)
}

export async function runAIReview(
  settings: AISettings,
  workspace: WorkspaceDataset,
  question: string,
): Promise<AIResult> {
  if (!settings.apiKey.trim()) {
    throw new Error('Enter an API key before running AI analysis.')
  }

  const chatChunks = chunkChatEvents(workspace)
  const runProvider = (prompt: string) =>
    settings.provider === 'openai'
      ? runOpenAI(settings, prompt)
      : runGemini(settings, prompt)

  let answer = ''

  if (chatChunks.length <= 1) {
    answer = await runProvider(buildPrompt(workspace, question))
  } else {
    const chunkFindings: string[] = []

    for (const [index, chunk] of chatChunks.entries()) {
      chunkFindings.push(
        await runProvider(buildChunkPrompt(question, chunk, index, chatChunks.length)),
      )
    }

    answer = await runProvider(buildSynthesisPrompt(workspace, question, chunkFindings))
  }

  if (!answer) {
    throw new Error('The AI provider returned an empty response.')
  }

  return {
    provider: settings.provider,
    model: settings.model,
    createdAt: new Date().toISOString(),
    question,
    answer,
  }
}
