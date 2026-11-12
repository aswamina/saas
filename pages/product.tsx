import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { PricingTable, Show, useAuth, UserButton } from '@clerk/nextjs';
import { fetchEventSource } from '@microsoft/fetch-event-source';

// The idea generator itself. Only rendered for users on the premium plan.
function IdeaGenerator() {
    const { getToken } = useAuth();
    const [idea, setIdea] = useState<string>('...loading');
    // Starts as true because the first idea is requested as soon as the page loads.
    const [isGenerating, setIsGenerating] = useState<boolean>(true);
    const controllerRef = useRef<AbortController | null>(null);

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
        setIdea('');
        setIsGenerating(true);
        startStream();
    };

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

            {/* Content Card */}
            <div className="max-w-3xl mx-auto">
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
                    {idea === '' ? (
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
                                {idea}
                            </ReactMarkdown>
                        </div>
                    )}
                </div>
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
