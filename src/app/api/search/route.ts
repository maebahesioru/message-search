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
  const q = request.nextUrl.searchParams.get("q")?.toLowerCase() || "";
  const offset = parseInt(request.nextUrl.searchParams.get("offset") || "0", 10);
  const limit = 50;
  const messages = getMessages();

  let matched: (Message & { originalIndex: number })[];

  if (!q) {
    matched = messages.map((m, i) => ({ ...m, originalIndex: i }));
  } else {
    matched = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (
        m.content.toLowerCase().includes(q) ||
        m.author.toLowerCase().includes(q)
      ) {
        matched.push({ ...m, originalIndex: i });
      }
    }
  }

  const count = matched.length;
  const results = matched.slice(offset, offset + limit);
  const hasMore = offset + limit < count;

  return Response.json({ count, results, hasMore });
}
