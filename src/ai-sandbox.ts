import { chat } from "@tanstack/ai";
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible";

// Using local models in llama.cpp with TanStack AI 😍
const adapter = openaiCompatibleText('qwen3.6-27b-q4_k_xl', {
    baseURL: 'http://localhost:10001/v1',
    apiKey: 'not-necessary',
})

const file = await Bun.file('./session-transcript.md').text()

const output = await chat({
  adapter,
  stream: false,
  systemPrompts: [
    `From the following coding session transcript,
    summarise what was worked on, and **why**.
    250 characters max.
    Don't focus on implementation details,
    but rather the overall goal and motivation behind the work.
    `.replace(/\s+/g, ' ').trim()],
  messages: [{ role: "user", content: file }]
});

console.log(output)


