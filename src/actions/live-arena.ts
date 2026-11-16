"use server";

import {
  commandLiveArena, fileArenaKnowledgeGap,
  loadArenaMaterial, loadArenaWorkspace, startLiveArena,
} from "@/services/live-arena.service";

export async function getArenaWorkspaceAction(id?: string) { return loadArenaWorkspace(id); }
export async function getArenaMaterialAction(id: string) { return loadArenaMaterial(id); }
export async function startArenaAction(input: unknown) { return startLiveArena(input); }
export async function commandArenaAction(id: string, command: string) { return commandLiveArena(id, command); }
export async function fileArenaGapAction(id: string, question: string) { return fileArenaKnowledgeGap(id, question); }
