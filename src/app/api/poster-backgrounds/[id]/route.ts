import { getCurrentAuthUser } from "@/services/auth.service";
import { readPosterBackgroundImage } from "@/storage/poster-background";

export const runtime = "nodejs";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await getCurrentAuthUser();
  if (!user) return new Response(null, { status: 401 });
  try {
    const image = await readPosterBackgroundImage((await params).id, user.businessId);
    return new Response(image as Uint8Array<ArrayBuffer>, { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" } });
  } catch { return new Response(null, { status: 404 }); }
}
