import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { PricingTable, Show, useAuth, UserButton } from '@clerk/nextjs';
import { fetchEventSource } from '@microsoft/fetch-event-source';

type SavedIdea = {
    id: string;
    content: string;
    created_at: string;
};

// Uses the idea's first Markdown heading (or first line) as its title in the list.
function ideaTitle(content: string): string {
    const firstLine = content.split('\n').find((line) => line.trim() !== '') ?? 'Untitled idea';
    const title = firstLine.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim();
    return title.length > 100 ? `${title.slice(0, 100)}…` : title;
}

type IdeasPage = {
    ideas: SavedIdea[];
    total: number;
    page: number;
    page_size: number;
};

// Sidebar list of the signed-in user's previously generated ideas, newest first,
// 10 per page. Clicking one shows it in the main card via `onSelect`.
// The parent remounts this (via `key`) when a new idea is saved, which reloads it
// and jumps back to page 1.
function IdeaHistory({
    selectedId,
    onSelect,
}: {
    selectedId: string | null;
    onSelect: (idea: SavedIdea) => void;
}) {
    const { getToken } = useAuth();
    const [page, setPage] = useState<number>(1);
    const [data, setData] = useState<IdeasPage | null>(null);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);

    const getTokenRef = useRef(getToken);
    useEffect(() => {
        getTokenRef.current = getToken;
    }, [getToken]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const jwt = await getTokenRef.current();
                if (!jwt) throw new Error('Not signed in');
                const res = await fetch(`/api/ideas?page=${page}`, {
                    headers: { Authorization: `Bearer ${jwt}` },
                });
                if (!res.ok) throw new Error(`Request failed (${res.status})`);
                const result = (await res.json()) as IdeasPage;
                if (!cancelled) {
                    setData(result);
                    setError(null);
                }
            } catch (err) {
                console.error('Failed to load ideas:', err);
                if (!cancelled) setError('Could not load your past ideas.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [page]);

    const goToPage = (next: number) => {
        setLoading(true);
        setPage(next);
    };

    const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

    return (
        <section className="bg-white/80 dark:bg-gray-800/80 backdrop-blur-lg rounded-2xl shadow-xl p-5">
            <div className="flex items-baseline justify-between mb-4">
                <h2 className="text-xl font-bold text-gray-800 dark:text-gray-200">Your ideas</h2>
                {data && data.total > 0 && (
                    <span className="text-sm text-gray-500 dark:text-gray-400">{data.total} saved</span>
                )}
            </div>

            {error ? (
                <p className="text-red-600 dark:text-red-400">{error}</p>
            ) : !data ? (
                <p className="animate-pulse text-gray-400">Loading your ideas...</p>
            ) : data.total === 0 ? (
                <p className="text-gray-500 dark:text-gray-400">No saved ideas yet. Generated ideas will appear here.</p>
            ) : (
                <>
                    <ul className={`space-y-2 transition-opacity ${loading ? 'opacity-50' : ''}`}>
                        {data.ideas.map((saved) => (
                            <li key={saved.id}>
                                <button
                                    type="button"
                                    onClick={() => onSelect(saved)}
                                    className={`w-full text-left rounded-lg px-3 py-2 transition-colors ${
                                        saved.id === selectedId
                                            ? 'bg-blue-100 dark:bg-blue-900/40'
                                            : 'hover:bg-gray-100 dark:hover:bg-gray-700'
                                    }`}
                                >
                                    <span className="block font-medium text-gray-800 dark:text-gray-200 line-clamp-2">
                                        {ideaTitle(saved.content)}
                                    </span>
                                    <span className="block text-xs text-gray-500 dark:text-gray-400 mt-1">
                                        {new Date(saved.created_at).toLocaleString()}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>

                    <div className="flex items-center justify-between mt-4 text-sm">
                        <button
                            type="button"
                            onClick={() => goToPage(page - 1)}
                            disabled={page <= 1 || loading}
                            className="px-3 py-1 rounded-lg text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            ← Prev
                        </button>
                        <span className="text-gray-500 dark:text-gray-400">
                            Page {page} of {totalPages}
                        </span>
                        <button
                            type="button"
                            onClick={() => goToPage(page + 1)}
                            disabled={page >= totalPages || loading}
                            className="px-3 py-1 rounded-lg text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            Next →
                        </button>
                    </div>
                </>
            )}
        </section>
    );
}

// The idea generator itself. Only rendered for users on the premium plan.
function IdeaGenerator() {
    const { getToken } = useAuth();
    const [idea, setIdea] = useState<string>('...loading');
    // Starts as true because the first idea is requested as soon as the page loads.
    const [isGenerating, setIsGenerating] = useState<boolean>(true);
    const controllerRef = useRef<AbortController | null>(null);
    // Bumped each time an idea finishes streaming (and has been saved), so the
    // "Your ideas" list reloads.
    const [historyVersion, setHistoryVersion] = useState<number>(0);
    // A saved idea picked from the sidebar; shown in the main card instead of the latest one.
    const [viewing, setViewing] = useState<SavedIdea | null>(null);

    // Keep the latest getToken in a ref so a new Clerk function identity
    // doesn't restart the stream.
    const getTokenRef = useRef(getToken);
    useEffect(() => {
        getTokenRef.current = getToken;
    }, [getToken]);

    // Opens the authenticated stream from /api. State only changes after an
    // await or inside the stream's callbacks, so this is safe to call from the
    // effect below.
    const startStream = useCallback(async () => {
        // Stop any stream that is still running before starting a new one.
        controllerRef.current?.abort();
        const controller = new AbortController();
        controllerRef.current = controller;
        let buffer = '';

        try {
            const jwt = await getTokenRef.current();
            if (controller.signal.aborted) return;
            if (!jwt) {
                setIdea('Authentication required');
                return;
            }

            await fetchEventSource('/api', {
                headers: { Authorization: `Bearer ${jwt}` },
                signal: controller.signal,
                // By default the library closes the stream when the tab is hidden
                // and reopens it when you come back, which would start a second
                // idea. Keep one stream open instead.
                openWhenHidden: true,
                onmessage(ev) {
                    // The API JSON-encodes each chunk so newlines survive the stream.
                    buffer += JSON.parse(ev.data) as string;
                    setIdea(buffer);
                },
                onerror(err) {
                    // Throwing stops the library from retrying, which would
                    // otherwise request (and pay for) another idea.
                    console.error('SSE error:', err);
                    throw err;
                },
            });
        } catch {
            if (!controller.signal.aborted && !buffer) {
                setIdea('Something went wrong generating an idea. Please try again.');
            }
        } finally {
            if (controllerRef.current === controller) {
                controllerRef.current = null;
                setIsGenerating(false);
                if (buffer) setHistoryVersion((v) => v + 1);
            }
        }
    }, []);

    useEffect(() => {
        // startStream only sets state after `await getToken()`, never synchronously,
        // but the lint rule can't see through the async function.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        startStream();
        return () => { controllerRef.current?.abort(); };
    }, [startStream]);

    const generateIdea = () => {
        setViewing(null);
        setIdea('');
        setIsGenerating(true);
        startStream();
    };

    const shown = viewing ? viewing.content : idea;

    return (
        <div className="container mx-auto px-4 py-12">
            {/* Header */}
            <header className="text-center mb-12">
                <h1 className="text-5xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent mb-4">
                    Business Idea Generator
                </h1>
                <p className="text-gray-600 dark:text-gray-400 text-lg">
                    AI-powered innovation at your fingertips
                </p>
            </header>

            {/* Two columns on large screens: idea on the left, "Your ideas" on the right.
                On smaller screens the list stacks below the idea. */}
            <div className="max-w-6xl mx-auto grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] items-start">
                {/* Content Card */}
                <div>
                    <div className="flex justify-center mb-6">
                        <button
                            type="button"
                            onClick={generateIdea}
                            disabled={isGenerating}
                            className="px-6 py-3 rounded-full font-semibold text-white bg-gradient-to-r from-blue-600 to-indigo-600 shadow-lg hover:from-blue-700 hover:to-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition"
                        >
                            {isGenerating ? 'Generating…' : 'Generate new idea'}
                        </button>
                    </div>

                    <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8 backdrop-blur-lg bg-opacity-95">
                        {viewing && (
                            <div className="flex items-center justify-between gap-4 mb-4 pb-4 border-b border-gray-200 dark:border-gray-700 text-sm">
                                <span className="text-gray-500 dark:text-gray-400">
                                    Saved idea from {new Date(viewing.created_at).toLocaleString()}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => setViewing(null)}
                                    className="text-blue-600 dark:text-blue-400 hover:underline"
                                >
                                    Back to latest
                                </button>
                            </div>
                        )}
                        {shown === '' ? (
                            <div className="flex items-center justify-center py-12">
                                <div className="animate-pulse text-gray-400">
                                    {isGenerating ? 'Generating your business idea...' : 'No idea yet. Try generating one.'}
                                </div>
                            </div>
                        ) : (
                            <div className="markdown-content text-gray-700 dark:text-gray-300">
                                <ReactMarkdown
                                    remarkPlugins={[remarkGfm, remarkBreaks]}
                                >
                                    {shown}
                                </ReactMarkdown>
                            </div>
                        )}
                    </div>
                </div>

                {/* Sidebar: stays in view while you scroll a long idea */}
                <aside className="lg:sticky lg:top-8">
                    <IdeaHistory
                        key={historyVersion}
                        selectedId={viewing?.id ?? null}
                        onSelect={(saved) => {
                            setViewing(saved);
                            window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                    />
                </aside>
            </div>
        </div>
    );
}

export default function Product() {
    return (
        <main className="relative min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
            {/* User Menu in Top Right */}
            <div className="absolute top-4 right-4">
                <UserButton showName={true} />
            </div>

            {/* Subscription Protection: premium users get the generator, everyone else sees the pricing table */}
            <Show
                when={{ plan: 'premium_subscription' }}
                fallback={
                    <div className="container mx-auto px-4 py-12">
                        <header className="text-center mb-12">
                            <h1 className="text-5xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent mb-4">
                                Choose Your Plan
                            </h1>
                            <p className="text-gray-600 dark:text-gray-400 text-lg mb-8">
                                Unlock unlimited AI-powered business ideas
                            </p>
                        </header>
                        <div className="max-w-4xl mx-auto">
                            <PricingTable />
                        </div>
                    </div>
                }
            >
                <IdeaGenerator />
            </Show>
        </main>
    );
}
