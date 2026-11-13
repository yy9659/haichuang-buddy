import { getCurrentAuthUser } from "@/services/auth.service";
import { readOwnedRemoteProductImage } from "@/services/product-assets.service";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentAuthUser();
  if (!user) return new Response(null, { status: 401 });
  try {
    const image = await readOwnedRemoteProductImage(user.businessId, (await params).id);
    if (!image) return new Response(null, { status: 404 });
    return new Response(image.bytes, { headers: {
      "Content-Type": image.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    return new Response(null, { status: 404 });
  }
}
