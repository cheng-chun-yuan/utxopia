import { NextRequest } from "next/server";
import { proxyToBackend } from "@/lib/api/backend-proxy";

export const GET = (req: NextRequest, { params }: { params: Promise<{ id: string }> }) =>
  params.then(({ id }) => proxyToBackend(req, `/api/stealth/${id}`));
