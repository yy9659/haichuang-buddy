import { redirect } from "next/navigation";
import { PublicKnowledgeManager } from "@/components/admin/public-knowledge-manager";
import { listPublishedPublicKnowledge } from "@/services/admin.service";
import { getCurrentAuthUser } from "@/services/auth.service";

export default async function PublicKnowledgePage() {
  if (!await getCurrentAuthUser()) redirect("/login");
  return <PublicKnowledgeManager documents={await listPublishedPublicKnowledge()} readOnly />;
}
