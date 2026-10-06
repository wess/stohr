import type { PipeFn } from "@atlas/server"
import { halt, parseJson as parse } from "@atlas/server"
import { limitBody } from "../limitbody/index.ts"

const cap = limitBody()

export const parseJson: PipeFn = async conn => {
  const limited = await cap(conn)
  if (limited.halted) return limited
  try {
    return await parse(limited)
  } catch (err) {
    if (err instanceof SyntaxError) return halt(limited, 400, { error: "Invalid JSON" })
    throw err
  }
}
