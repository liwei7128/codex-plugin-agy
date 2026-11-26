import path from "node:path";
import { pathInWorkspace } from "../security/index.js";

export interface HandoffPackage {
  objective: string;
  summary: string;
  architecture_decisions?: string[];
  constraints?: string[];
  relevant_files?: string[];
  previous_attempts?: string[];
  unresolved_issues?: string[];
  acceptance_criteria?: string[];
}

export function prepareHandoff(cwd: string, handoff: HandoffPackage) {
  const relevant_files = (handoff.relevant_files ?? []).map(file => path.relative(cwd, pathInWorkspace(cwd, file, true)) || ".");
  return {
    prompt: "Accept this explicit Antigravity handoff as task context. Briefly state the objective, key constraints and open questions. Wait for a follow-up task before changing anything.\n<handoff>\n" +
      JSON.stringify({ ...handoff, relevant_files }) + "\n</handoff>",
    threadName: "Antigravity Handoff: " + handoff.objective.slice(0, 56),
  };
}
