import { proxyToBackend } from "@/lib/api/backend-proxy";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ hash: string }> }
) {
  const { hash } = await params;
  return proxyToBackend(request, `/api/nullifiers/${hash}`);
}
