import { NextRequest } from "next/server";
import { proxyToBackend } from "@/lib/api/backend-proxy";
export const dynamic = "force-dynamic";

// /api/tree/leaves removed — proxy to /api/announcements instead
export const GET = (req: NextRequest) => proxyToBackend(req, "/api/announcements");
