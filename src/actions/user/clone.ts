import type { Step } from "../primitives/types.ts"
import type { EventName } from "../types.ts"

export type ClonePlan = {
  name: string
  description: string
  icon: string
  triggers: EventName[]
  steps: Step[]
}

const CLONE_MAP: Record<string, ClonePlan> = {
  "stohr/resize-image": {
    name: "My Resize image",
    description: "Shrinks every image to a maximum width while keeping its proportions.",
    icon: "Image",
    triggers: ["file.created", "file.moved.in"],
    steps: [
      { kind: "filter.mime", config: { allow: ["image"] } },
      { kind: "transform.resize", config: { width: 1024, fit: "inside" } },
    ],
  },
  "stohr/organize-by-date": {
    name: "My Organize by date",
    description: "Sorts uploads into year and month subfolders based on when they were added.",
    icon: "Calendar",
    triggers: ["file.created", "file.moved.in"],
    steps: [
      { kind: "route.move", config: { path_template: "{YYYY}/{MM}" } },
    ],
  },
}

export const cloneFor = (slug: string): ClonePlan | null => CLONE_MAP[slug] ?? null

export const cloneableSlugs = (): string[] => Object.keys(CLONE_MAP)
