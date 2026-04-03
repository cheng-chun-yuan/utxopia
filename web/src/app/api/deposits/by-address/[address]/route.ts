import { NextRequest } from "next/server";
import { proxyToBackend } from "@/lib/api/backend-proxy";
export const dynamic = "force-dynamic";

export const GET = (req: NextRequest, { params }: { params: Promise<{ address: string }> }) =>
  params.then(({ address }) => proxyToBackend(req, `/api/deposits/by-address/${address}`));
