'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type Message = {
  ts: string;
  author: string;
  author_id: string;
  content: string;
  has_attach: boolean;
  attach_urls: string[];
  originalIndex?: number;
};

type ContextData = {
  results: Message[];
  centerIndex: number;
  startIndex: number;
};

const IMG_EXT = /\.(png|jpg|jpeg|gif|webp|bmp|svg)(\?|$)/i;
const URL_RE = /(https?:\/\/\S+)/g;

function proxyUrl(url: string): string {
  return `/api/proxy-image?url=${encodeURIComponent(url)}`;
}

function highlightText(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-yellow-200 px-0.5 text-inherit dark:bg-yellow-600 dark:text-white">
        {text.slice(idx, idx + query.length)}
      </mark>
      {highlightText(text.slice(idx + query.length), query)}
    </>
  );
}

function formatContent(text: string, query: string): React.ReactNode {
  const parts = text.split(URL_RE);
  return parts.map((part, i) => {
    if (i % 2 === 0) {
      return <span key={i}>{highlightText(part, query)}</span>;
    }
    if (IMG_EXT.test(part)) {
      return (
        <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="block my-2">
          <img
            src={proxyUrl(part)}
            alt=""
            loading="lazy"
            className="max-w-full h-auto max-h-96 rounded border border-gray-200 dark:border-gray-700"
          />
        </a>
      );
    }
    return (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-500 underline break-all hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
      >
        {part}
      </a>
    );
  });
}

const LIMIT = 50;

export default function Home() {
  const [results, setResults] = useState<Message[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [openContexts, setOpenContexts] = useState<Record<number, boolean>>({});
  const [contextCache, setContextCache] = useState<Record<number, ContextData>>({});
  const [contextLoading, setContextLoading] = useState<Record<number, boolean>>({});
  const offsetRef = useRef(0);
  const queryRef = useRef('');
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const search = useCallback((q: string, append = false) => {
    const offset = append ? offsetRef.current : 0;
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
      setResults([]);
      setOpenContexts({});
      setContextCache({});
    }
    setError(null);
    queryRef.current = q;

    fetch(`/api/search?q=${encodeURIComponent(q)}&offset=${offset}`)
      .then((res) => {
        if (!res.ok) throw new Error('Search failed');
        return res.json();
      })
      .then(
        (data: { count: number; results: Message[]; hasMore: boolean }) => {
          setResults((prev) => (append ? [...prev, ...data.results] : data.results));
          setTotalCount(data.count);
          setHasMore(data.hasMore);
          offsetRef.current = append ? offsetRef.current + LIMIT : LIMIT;
          setLoading(false);
          setLoadingMore(false);
        }
      )
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Unknown error');
        setLoading(false);
        setLoadingMore(false);
      });
  }, []);

  useEffect(() => {
    search('');
  }, [search]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading && !loadingMore) {
          search(queryRef.current, true);
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, search]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(val), 200);
  };

  const toggleContext = async (originalIndex: number) => {
    if (openContexts[originalIndex]) {
      setOpenContexts((prev) => ({ ...prev, [originalIndex]: false }));
      return;
    }
    if (contextCache[originalIndex]) {
      setOpenContexts((prev) => ({ ...prev, [originalIndex]: true }));
      return;
    }
    setContextLoading((prev) => ({ ...prev, [originalIndex]: true }));
    try {
      const res = await fetch(`/api/context?index=${originalIndex}`);
      if (!res.ok) throw new Error('Failed to load context');
      const data: ContextData = await res.json();
      setContextCache((prev) => ({ ...prev, [originalIndex]: data }));
      setOpenContexts((prev) => ({ ...prev, [originalIndex]: true }));
    } catch (err) {
      console.error(err);
    } finally {
      setContextLoading((prev) => ({ ...prev, [originalIndex]: false }));
    }
  };

  const formatDate = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-900 dark:text-gray-100">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold">メッセージ検索</h1>

        <div className="mb-6">
          <input
            type="text"
            value={query}
            onChange={handleChange}
            placeholder="作者または内容で検索..."
            className="w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-base shadow-sm outline-none transition placeholder:text-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 dark:border-gray-700 dark:bg-gray-800 dark:focus:border-blue-400 dark:focus:ring-blue-900"
          />
        </div>

        {loading && (
          <p className="text-gray-500 dark:text-gray-400">
            {query ? '検索中...' : '読み込み中...'}
          </p>
        )}

        {error && <p className="text-red-500">エラー: {error}</p>}

        {!loading && !error && (
          <div className="space-y-4">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {totalCount.toLocaleString()} 件
              {query && ' ヒット'}
            </p>

            {results.length === 0 ? (
              <p className="text-gray-500 dark:text-gray-400">
                {query
                  ? '該当するメッセージが見つかりませんでした。'
                  : '検索ワードを入力してください。'}
              </p>
            ) : (
              <ul className="space-y-3">
                {results.map((m, idx) => (
                  <li
                    key={`${m.ts}-${m.author_id}-${idx}`}
                    className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm transition hover:shadow-md dark:border-gray-700 dark:bg-gray-800"
                  >
                    <div className="mb-1 flex items-center justify-between">
                      <span className="font-semibold text-blue-600 dark:text-blue-400">
                        {highlightText(m.author, query)}
                      </span>
                      <span className="text-xs text-gray-400 dark:text-gray-500">
                        {formatDate(m.ts)}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">
                      {formatContent(m.content, query)}
                    </p>
                    {m.has_attach && m.attach_urls.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {m.attach_urls.map((url, i) =>
                          IMG_EXT.test(url) ? (
                            <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                              <img
                                src={proxyUrl(url)}
                                alt={`添付${i + 1}`}
                                loading="lazy"
                                className="max-w-full h-auto max-h-64 rounded border border-gray-200 dark:border-gray-700"
                              />
                            </a>
                          ) : (
                            <a
                              key={i}
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-blue-500 underline hover:text-blue-700 dark:hover:text-blue-300"
                            >
                              添付{i + 1}
                            </a>
                          )
                        )}
                      </div>
                    )}

                    {m.originalIndex !== undefined && (() => {
                      const oIdx = m.originalIndex;
                      return (
                      <div className="mt-3">
                        <button
                          onClick={() => toggleContext(oIdx)}
                          disabled={contextLoading[oIdx]}
                          className="rounded-md bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                        >
                          {contextLoading[oIdx]
                            ? '読み込み中...'
                            : openContexts[oIdx]
                            ? '周辺を閉じる'
                            : '周辺を表示'}
                        </button>

                        {openContexts[oIdx] && contextCache[oIdx] && (
                          <div className="mt-2 rounded-lg border border-gray-100 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/50">
                            <p className="mb-2 text-xs font-semibold text-gray-400">前後の会話</p>
                            <div className="space-y-2">
                              {contextCache[oIdx].results.map((cm, cidx) => {
                                const ctx = contextCache[oIdx];
                                const isCenter = cidx === (ctx.centerIndex - ctx.startIndex);
                                return (
                                  <div
                                    key={cidx}
                                    className={`rounded-md px-2 py-1.5 ${
                                      isCenter
                                        ? 'bg-yellow-50 dark:bg-yellow-900/20'
                                        : ''
                                    }`}
                                  >
                                    <div className="flex items-baseline gap-2">
                                      <span className="text-xs font-semibold text-blue-600 dark:text-blue-400">
                                        {cm.author}
                                      </span>
                                      <span className="text-[10px] text-gray-400">
                                        {formatDate(cm.ts)}
                                      </span>
                                    </div>
                                    <p className="text-sm leading-relaxed text-gray-700 dark:text-gray-300">
                                      {formatContent(cm.content, query)}
                                    </p>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )})()}
                  </li>
                ))}
              </ul>
            )}

            {loadingMore && (
              <p className="text-center text-sm text-gray-400 dark:text-gray-500">
                読み込み中...
              </p>
            )}

            {!hasMore && results.length > 0 && (
              <p className="text-center text-sm text-gray-400 dark:text-gray-500">
                すべて表示しました
              </p>
            )}

            <div ref={sentinelRef} className="h-1" />
          </div>
        )}
      </div>
    </div>
  );
}
