import { authPost } from "../../_lib/auth-route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export async function POST(request: Request) {
  return authPost(request, "password");
}
