import { proxyToBackend } from "@/lib/api/backend-proxy";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return proxyToBackend(request, `/api/tracker/retry/${id}`);
}
