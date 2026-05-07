import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";

type Message = {
  ts: string;
  author: string;
  author_id: string;
  content: string;
  has_attach: boolean;
  attach_urls: string[];
};

let cachedMessages: Message[] | null = null;
let cachedMtime = 0;

function getMessages(): Message[] {
  const filePath = path.join(process.cwd(), "public", "messages.json");
  const stat = fs.statSync(filePath);
  if (cachedMessages && stat.mtimeMs <= cachedMtime) return cachedMessages;
  const raw = fs.readFileSync(filePath, "utf-8");
  cachedMessages = JSON.parse(raw) as Message[];
  cachedMtime = stat.mtimeMs;
  return cachedMessages;
}

export async function GET(request: NextRequest) {
  const index = parseInt(request.nextUrl.searchParams.get("index") || "0", 10);
  const messages = getMessages();
  const start = Math.max(0, index - 5);
  const end = Math.min(messages.length, index + 6);

  return Response.json({
    results: messages.slice(start, end),
    centerIndex: index,
    startIndex: start,
  });
}
