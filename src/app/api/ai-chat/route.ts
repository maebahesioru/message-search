import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";

const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://tenbin2api.hikamer.f5.si/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-dummy";

let cachedMessages: Array<{
  ts: string;
  author: string;
  author_id: string;
  content: string;
  has_attach: boolean;
  attach_urls: string[];
}> | null = null;

function getMessages() {
  if (cachedMessages) return cachedMessages;
  const fp = path.join(process.cwd(), "public", "messages.json");
  cachedMessages = JSON.parse(fs.readFileSync(fp, "utf-8"));
  return cachedMessages!;
}

function formatTs(ts: string) {
  return new Date(ts).toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildContext(question: string) {
  const messages = getMessages();
  const authors = [...new Set(messages.map((m) => m.author))];

  const recent = messages.slice(-200);

  const q = question.toLowerCase();
  const keywords = q
    .replace(/[?？！!。、,.\s]/g, " ")
    .split(" ")
    .filter((w) => w.length >= 2);

  const related = messages.filter((m) => {
    const content = m.content.toLowerCase();
    return keywords.some((kw) => content.includes(kw));
  });

  const seen = new Set<string>();
  const contextMessages = [...recent, ...related]
    .filter((m) => {
      if (seen.has(m.ts)) return false;
      seen.add(m.ts);
      return true;
    })
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(-300);

  const lines = contextMessages.map((m) => {
    const date = formatTs(m.ts);
    const content = m.content.replace(/\n/g, " ");
    return `[${date}] ${m.author}: ${content}`;
  });

  return {
    authors,
    total: messages.length,
    contextLines: lines,
    dateRange: `${formatTs(messages[0].ts)} 〜 ${formatTs(messages[messages.length - 1].ts)}`,
  };
}

export async function POST(req: NextRequest) {
  try {
    const { question, systemHint } = await req.json();
    if (!question || typeof question !== "string") {
      return Response.json({ error: "question required" }, { status: 400 });
    }

    const ctx = buildContext(question);

    const systemPrompt =
      systemHint ||
      `あなたはDiscord DMのログ分析アシスタントです。
以下のDMログ（${ctx.total}件、${ctx.dateRange}）を元に、ユーザーの質問に答えてください。
話者: ${ctx.authors.join(", ")}

【DMログ（抜粋）】
${ctx.contextLines.slice(-150).join("\n")}

上記ログを参考に、日本語で簡潔・正確に答えてください。ログに無い情報は「ログには記載がない」と述べてください。`;

    const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "GeminiPro31Preview",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: question },
        ],
        stream: false,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return Response.json(
        { error: `API error ${res.status}: ${errText.slice(0, 200)}` },
        { status: 502 }
      );
    }

    const data = await res.json();
    const answer = data.choices?.[0]?.message?.content || "";

    return Response.json({ answer });
  } catch (err: any) {
    console.error("AI chat error:", err);
    return Response.json(
      { error: err.message || "Internal error" },
      { status: 500 }
    );
  }
}
