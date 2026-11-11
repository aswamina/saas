import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

export default function Home() {
    const [idea, setIdea] = useState<string>('');
    // Starts as true because the first idea is requested as soon as the page loads.
    const [isGenerating, setIsGenerating] = useState<boolean>(true);
    const sourceRef = useRef<EventSource | null>(null);

    // Opens the stream from /api. State only changes inside the stream's callbacks,
    // so this is safe to call from the effect below.
    const startStream = useCallback(() => {
        // Stop any stream that is still running before starting a new one.
        sourceRef.current?.close();

        const evt = new EventSource('/api');
        sourceRef.current = evt;
        let buffer = '';

        evt.onmessage = (e) => {
            buffer += e.data;
            setIdea(buffer);
        };
        evt.onerror = () => {
            // The server closes the connection when the idea is complete, which
            // EventSource reports as an error. Close it so it doesn't reconnect
            // and start generating a second idea on its own.
            evt.close();
            if (sourceRef.current === evt) {
                sourceRef.current = null;
                setIsGenerating(false);
            }
        };
    }, []);

    useEffect(() => {
        startStream();
        return () => { sourceRef.current?.close(); };
    }, [startStream]);

    const generateIdea = () => {
        setIdea('');
        setIsGenerating(true);
        startStream();
    };

    return (
        <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
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
        </main>
    );
}
