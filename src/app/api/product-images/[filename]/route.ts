import { readFile } from "node:fs/promises";
import { getCurrentAuthUser } from "@/services/auth.service";
import { ownsLocalProductImage } from "@/services/product-assets.service";

import {
  localProductImageContentType,
  localProductImagePath,
} from "@/storage/local-product-image";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ filename: string }> },
): Promise<Response> {
  const { filename } = await context.params;
  const contentType = localProductImageContentType(filename);
  const filePath = localProductImagePath(filename);
  if (!contentType || !filePath) {
    return new Response(null, { status: 404 });
  }

  try {
    const user = await getCurrentAuthUser();
    if (!user) return new Response(null, { status: 401 });
    if (!await ownsLocalProductImage(user.businessId, filename)) return new Response(null, { status: 404 });
    const image = await readFile(filePath);
    return new Response(new Uint8Array(image), {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(image.byteLength),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
