"use server";

import { revalidatePath } from "next/cache";
import { deletePublicKnowledge, savePublicKnowledge } from "@/services/admin.service";
import type { PublicKnowledgeInput } from "@/types/admin";

export async function savePublicKnowledgeAction(id: string | null, input: PublicKnowledgeInput) {
  const result = await savePublicKnowledge(id, input);
  if (result.ok) { revalidatePath("/admin/knowledge"); revalidatePath("/public-knowledge"); }
  return result;
}
export async function deletePublicKnowledgeAction(id: string) {
  const result = await deletePublicKnowledge(id);
  if (result.ok) { revalidatePath("/admin/knowledge"); revalidatePath("/public-knowledge"); }
  return result;
}
