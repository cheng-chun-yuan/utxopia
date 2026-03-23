import { NextRequest } from "next/server";
import { proxyToBackend } from "@/lib/api/backend-proxy";
export const dynamic = "force-dynamic";

export const GET = (req: NextRequest) => proxyToBackend(req, "/api/deposits");
export const POST = (req: NextRequest) => proxyToBackend(req, "/api/deposits");
