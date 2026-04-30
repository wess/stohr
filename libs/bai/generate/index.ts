import { JSCallback, FFIType } from "bun:ffi"
import { native, lastError, cstr } from "../ffi/index.ts"
import type { Model } from "../models/index.ts"

export type GenerateOptions = {
  readonly maxTokens?: number
  readonly temperature?: number
  readonly stop?: readonly string[]
}

export type GenerateChunk = {
  readonly text: string
  readonly done: boolean
}

const DEFAULT_MAX = 512
const DEFAULT_TEMP = 0.7

// Buffered, non-streaming variant. The native callback is still per-token —
// we just collect into a string. Convenient when you don't need to render
// progressively.
export const generate = async (
  model: Model,
  prompt: string,
  opts: GenerateOptions = {},
): Promise<string> => {
  let collected = ""
  for await (const chunk of generateStream(model, prompt, opts)) {
    if (!chunk.done) collected += chunk.text
  }
  return collected
}

// Streaming generator. Each yielded chunk is at most one token's text.
// The callback bridges the synchronous llama.cpp loop to JS — we collect
// tokens into a queue and the async iterator drains it.
//
// llama.cpp's main-loop is blocking, so this whole thing runs on the
// JS thread. For long generations consider running on a worker.
export const generateStream = async function* (
  model: Model,
  prompt: string,
  opts: GenerateOptions = {},
): AsyncGenerator<GenerateChunk> {
  if (model.kind !== "llm") {
    throw new Error(`bai: model '${model.preset ?? model.path}' is an embedding model — use embed() instead`)
  }

  const maxTokens = opts.maxTokens ?? DEFAULT_MAX
  const temperature = opts.temperature ?? DEFAULT_TEMP

  const queue: string[] = []
  let aborted = false
  const stop = opts.stop ?? []

  const decoder = new TextDecoder("utf-8", { fatal: false })

  // Native side calls back per-token with a (cstring, user) signature.
  // Returning 1 aborts; returning 0 continues. bun:ffi decodes the
  // cstring into a JS string for us.
  const cb = new JSCallback(
    (token: string | null, _user: unknown) => {
      if (aborted) return 1
      const text = token ?? ""
      queue.push(text)
      // Stop-string check is done JS-side because tokens may merge into
      // the stop sequence across multiple callbacks.
      if (stop.length > 0) {
        const tail = queue.slice(-8).join("")
        for (const s of stop) {
          if (s && tail.includes(s)) return 1
        }
      }
      return 0
    },
    {
      args: [FFIType.cstring, FFIType.ptr],
      returns: FFIType.i32,
    },
  )

  try {
    // Fire the generation in the background; we don't await it because
    // the async iterator below needs to interleave with native callbacks.
    // bun:ffi's `dlopen` returns sync functions; offload via Promise.resolve
    // + queueMicrotask so the iterator can yield while native runs.
    const runPromise = new Promise<number>((resolveRun) => {
      queueMicrotask(() => {
        const rc = native.bai_generate(
          model.ptr,
          cstr(prompt),
          maxTokens,
          temperature,
          cb.ptr,
          null,
        )
        resolveRun(rc)
      })
    })

    // Drain loop. Yield whatever has been pushed; if empty and the run
    // hasn't finished, defer once and loop. This is cooperative — the
    // native call will run to completion on a microtask before we get
    // another scheduling slot, so streaming is best-effort. For true
    // token-level streaming, run generation on a worker thread.
    let done = false
    let rc = 0
    runPromise.then((r) => { rc = r; done = true })

    while (!done || queue.length > 0) {
      while (queue.length > 0) {
        const t = queue.shift() as string
        yield { text: t, done: false }
      }
      if (!done) {
        await new Promise<void>((res) => setTimeout(res, 0))
      }
    }

    if (rc !== 0 && !aborted) {
      throw new Error(`bai: generate failed (rc=${rc}): ${lastError()}`)
    }
    yield { text: "", done: true }
  } finally {
    aborted = true
    cb.close()
  }
}

