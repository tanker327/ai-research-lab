// @lab/agents — versioned agent implementations (implementation-plan §3).
// Prompts are versioned source: packages/agents/src/<role>/<version>/.
export { plannerV1 } from "./planner/v1";
export { type ResearcherAgentResult, researcherV1 } from "./researcher/v1";
export type { Agent, AgentContext } from "./types";
