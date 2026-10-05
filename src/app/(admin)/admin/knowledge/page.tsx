import { PublicKnowledgeManager } from "@/components/admin/public-knowledge-manager";
import { guardAdminPage } from "@/lib/admin-page";
import { listPublicKnowledgeForAdmin } from "@/services/admin.service";

export default async function KnowledgePage() {
  await guardAdminPage();
  return <PublicKnowledgeManager documents={await listPublicKnowledgeForAdmin()} />;
}
