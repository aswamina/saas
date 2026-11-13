import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { PricingTable, Show, useAuth, UserButton } from '@clerk/nextjs';
import { fetchEventSource } from '@microsoft/fetch-event-source';

type SavedIdea = {
    id: string;
    content: string;
    category: string | null;
    created_at: string;
};

type Category = {
    category_id: number;
    name: string;
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
                                    {saved.category && (
                                        <span className="inline-block mt-1 px-2 py-0.5 rounded-full text-xs bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                                            {saved.category}
                                        </span>
                                    )}
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
    const [idea, setIdea] = useState<string>('');
    // Nothing is generated until the user clicks "Generate new idea".
    const [isGenerating, setIsGenerating] = useState<boolean>(false);
    const controllerRef = useRef<AbortController | null>(null);
    // Bumped each time an idea finishes streaming (and has been saved), so the
    // "Your ideas" list reloads.
    const [historyVersion, setHistoryVersion] = useState<number>(0);
    // A saved idea picked from the sidebar; shown in the main card instead of the latest one.
    const [viewing, setViewing] = useState<SavedIdea | null>(null);
    // Categories for the dropdown (loaded from Supabase via /api/categories).
    // '' means "Any category".
    const [categories, setCategories] = useState<Category[]>([]);
    const [categoryId, setCategoryId] = useState<string>('');

    // Keep the latest getToken in a ref so a new Clerk function identity
    // doesn't restart the stream.
    const getTokenRef = useRef(getToken);
    useEffect(() => {
        getTokenRef.current = getToken;
    }, [getToken]);

    // Opens the authenticated stream from /api.
    const startStream = useCallback(async (selectedCategoryId?: string) => {
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

            const url = selectedCategoryId
                ? `/api?category_id=${encodeURIComponent(selectedCategoryId)}`
                : '/api';
            await fetchEventSource(url, {
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

    // Stop any stream that's still running if the user leaves the page.
    useEffect(() => {
        return () => { controllerRef.current?.abort(); };
    }, []);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const jwt = await getTokenRef.current();
                if (!jwt) return;
                const res = await fetch('/api/categories', {
                    headers: { Authorization: `Bearer ${jwt}` },
                });
                if (!res.ok) throw new Error(`Request failed (${res.status})`);
                const data = (await res.json()) as Category[];
                if (!cancelled) setCategories(data);
            } catch (err) {
                // The generator still works without categories ("Any category").
                console.error('Failed to load categories:', err);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const generateIdea = () => {
        setViewing(null);
        setIdea('');
        setIsGenerating(true);
        startStream(categoryId);
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
                    <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-6">
                        <div className="relative w-full sm:w-72">
                            <label htmlFor="category" className="sr-only">Category</label>
                            {/* Tag icon on the left */}
                            <svg
                                aria-hidden="true"
                                viewBox="0 0 20 20"
                                fill="currentColor"
                                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-indigo-500 dark:text-indigo-400"
                            >
                                <path fillRule="evenodd" d="M5.5 3A2.5 2.5 0 0 0 3 5.5v2.879a2.5 2.5 0 0 0 .732 1.767l6.5 6.5a2.5 2.5 0 0 0 3.536 0l2.878-2.878a2.5 2.5 0 0 0 0-3.536l-6.5-6.5A2.5 2.5 0 0 0 8.38 3H5.5ZM6 7a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
                            </svg>
                            <select
                                id="category"
                                value={categoryId}
                                onChange={(e) => setCategoryId(e.target.value)}
                                disabled={isGenerating}
                                className="w-full appearance-none cursor-pointer truncate rounded-full border border-indigo-200 bg-white/90 py-3 pl-11 pr-11 text-sm font-medium text-gray-800 shadow-lg backdrop-blur transition hover:border-indigo-400 focus:border-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-gray-800/90 dark:text-gray-100 dark:hover:border-indigo-400"
                            >
                                <option value="" className="bg-white text-gray-800 dark:bg-gray-800 dark:text-gray-100">
                                    Any category
                                </option>
                                {categories.map((c) => (
                                    <option
                                        key={c.category_id}
                                        value={String(c.category_id)}
                                        className="bg-white text-gray-800 dark:bg-gray-800 dark:text-gray-100"
                                    >
                                        {c.name}
                                    </option>
                                ))}
                            </select>
                            {/* Chevron on the right (replaces the browser's default arrow) */}
                            <svg
                                aria-hidden="true"
                                viewBox="0 0 20 20"
                                fill="currentColor"
                                className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400"
                            >
                                <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                            </svg>
                        </div>
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
                                    Saved idea{viewing.category ? ` · ${viewing.category}` : ''} · {new Date(viewing.created_at).toLocaleString()}
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
                        {shown === '' && isGenerating ? (
                            <div className="flex items-center justify-center py-12">
                                <div className="animate-pulse text-gray-400">
                                    Generating your business idea...
                                </div>
                            </div>
                        ) : shown === '' ? (
                            // First visit (or nothing generated yet): explain how to get started.
                            <div className="py-6 text-center">
                                <h2 className="text-2xl font-bold text-gray-800 dark:text-gray-100 mb-2">
                                    Ready for your next big idea?
                                </h2>
                                <p className="text-gray-600 dark:text-gray-400 mb-8">
                                    Get an AI-generated business idea for AI agents in a few seconds.
                                </p>
                                <ol className="mx-auto max-w-md space-y-4 text-left">
                                    <li className="flex gap-4">
                                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 font-semibold text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">1</span>
                                        <span className="text-gray-700 dark:text-gray-300">
                                            <strong>Choose a category</strong> from the dropdown above to get an idea tailored to that industry, or leave it on <strong>Any category</strong> for a broader idea.
                                        </span>
                                    </li>
                                    <li className="flex gap-4">
                                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 font-semibold text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">2</span>
                                        <span className="text-gray-700 dark:text-gray-300">
                                            Click <strong>Generate new idea</strong> and watch it appear here.
                                        </span>
                                    </li>
                                    <li className="flex gap-4">
                                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 font-semibold text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">3</span>
                                        <span className="text-gray-700 dark:text-gray-300">
                                            Every idea is saved to <strong>Your ideas</strong>, so you can come back to it any time.
                                        </span>
                                    </li>
                                </ol>
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
