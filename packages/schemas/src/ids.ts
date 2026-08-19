// THE id helper (CLAUDE.md conventions): UUIDv7 everywhere — time-ordered ids
// give events/attempts natural index locality. Never crypto.randomUUID().
import { uuidv7 } from "uuidv7";

export function newId(): string {
  return uuidv7();
}
