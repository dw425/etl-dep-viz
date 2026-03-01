/**
 * AIChat — main AI chat interface with conversation panel and context sidebar.
 *
 * Left panel: message history, input bar, suggested questions.
 * Right panel: referenced sessions/tables with navigation links.
 */

import { useState, useRef, useEffect } from 'react';
import type { TierMapResult } from '../../types/tiermap';
import { chatIndexStatus, chatIndexUpload, chatQuery, chatReindex } from '../../api/client';

/* ── Types ──────────────────────────────────────────────────────────────── */

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  intent?: string;
  referenced_sessions?: SessionRef[];
  referenced_tables?: TableRef[];
  suggested_questions?: string[];
  timestamp: string;
}

interface SessionRef {
  name: string;
  short_name: string;
  tier: number;
  complexity?: number;
}

interface TableRef {
  name: string;
  type: string;
}

interface AIChatProps {
  uploadId: number | null;
  tierData: TierMapResult | null;
  onNavigate?: (view: string, params: Record<string, unknown>) => void;
}

/* ── Component ──────────────────────────────────────────────────────────── */

export default function AIChat({ uploadId, tierData, onNavigate }: AIChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [indexed, setIndexed] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [docCount, setDocCount] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Check index status when uploadId changes
  useEffect(() => {
    if (uploadId) checkIndexStatus();
  }, [uploadId]);

  async function checkIndexStatus() {
    if (!uploadId) return;
    try {
      const data = await chatIndexStatus(uploadId);
      setIndexed(data.indexed);
      setDocCount(data.document_count);
    } catch {
      setIndexed(false);
    }
  }

  async function buildIndex() {
    if (!uploadId) return;
    setIndexing(true);
    try {
      const data = await chatIndexUpload(uploadId) as { documents_indexed?: number; by_type?: Record<string, number> };
      setIndexed(true);
      setDocCount(data.documents_indexed || 0);
      const byType = data.by_type || {};
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Index built! ${data.documents_indexed || 0} documents indexed (${byType.session || 0} sessions, ${byType.table || 0} tables, ${byType.chain || 0} chains, ${byType.group || 0} groups). Ask me anything about your ETL environment.`,
        timestamp: new Date().toISOString(),
      }]);
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Failed to build index: ${err instanceof Error ? err.message : 'Unknown error'}. Make sure the AI dependencies are installed (pip install -e ".[ai]").`,
        timestamp: new Date().toISOString(),
      }]);
    } finally {
      setIndexing(false);
    }
  }

  async function sendMessage() {
    if (!input.trim() || !uploadId || loading) return;

    const userMsg: ChatMessage = {
      role: 'user',
      content: input.trim(),
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const data = await chatQuery(uploadId, userMsg.content, messages.slice(-10).map(m => ({
        role: m.role,
        content: m.content,
      }))) as {
        answer: string;
        intent?: string;
        referenced_sessions?: SessionRef[];
        referenced_tables?: TableRef[];
        suggested_questions?: string[];
      };

      const aiMsg: ChatMessage = {
        role: 'assistant',
        content: data.answer,
        intent: data.intent,
        referenced_sessions: data.referenced_sessions,
        referenced_tables: data.referenced_tables,
        suggested_questions: data.suggested_questions,
        timestamp: new Date().toISOString(),
      };
      setMessages(prev => [...prev, aiMsg]);
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Error: ${err instanceof Error ? err.message : 'Unknown error'}. Make sure EDV_LLM_API_KEY is set.`,
        timestamp: new Date().toISOString(),
      }]);
    } finally {
      setLoading(false);
    }
  }

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const aiMessages = messages.filter(m => m.role === 'assistant');
  const lastAIMessage = aiMessages.length > 0 ? aiMessages[aiMessages.length - 1] : undefined;

  const starterQuestions = [
    'What are the most complex sessions?',
    'Which tables have write conflicts?',
    'Show me the critical path',
    "What's in Wave 1?",
    'How many sessions are there?',
    'Which sessions have the highest blast radius?',
  ];

  // No upload loaded
  if (!uploadId) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        <div className="text-center">
          <p className="text-4xl mb-4">&#x1F4AC;</p>
          <p className="text-lg">Upload ETL files first to use AI Chat</p>
          <p className="text-sm mt-2">The AI assistant needs parsed data to answer questions</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* LEFT: Chat Panel */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Messages area */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Index prompt */}
          {!indexed && !indexing && (
            <div className="bg-amber-900/30 border border-amber-500/30 rounded-lg p-4 text-center">
              <p className="text-amber-300 mb-3">
                This upload hasn't been indexed for AI search yet.
              </p>
              <button
                onClick={buildIndex}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors"
              >
                Build AI Index ({tierData?.sessions?.length ?? 0} sessions)
              </button>
            </div>
          )}

          {/* Indexing spinner */}
          {indexing && (
            <div className="bg-blue-900/30 border border-blue-500/30 rounded-lg p-4 text-center">
              <div className="animate-spin w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full mx-auto mb-2" />
              <p className="text-blue-300">Building vector index...</p>
            </div>
          )}

          {/* Re-index button — shown when indexed but vectors may have been updated */}
          {indexed && !indexing && (
            <div className="flex items-center gap-3 px-4 py-2 bg-gray-800/50 rounded-lg mb-2">
              <span className="text-xs text-gray-500">
                {docCount} docs indexed
              </span>
              <button
                onClick={async () => {
                  if (!uploadId) return;
                  setIndexing(true);
                  try {
                    const data = await chatReindex(uploadId) as { documents_indexed?: number; by_type?: Record<string, number> };
                    setDocCount(data.documents_indexed || 0);
                    setMessages(prev => [...prev, {
                      role: 'assistant' as const,
                      content: `Re-indexed with vector data! ${data.documents_indexed || 0} documents now include complexity, wave, and community data.`,
                      timestamp: new Date().toISOString(),
                    }]);
                  } catch (err) {
                    setMessages(prev => [...prev, {
                      role: 'assistant' as const,
                      content: `Re-index failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
                      timestamp: new Date().toISOString(),
                    }]);
                  } finally {
                    setIndexing(false);
                  }
                }}
                className="text-xs px-2 py-1 bg-purple-900/30 text-purple-300 rounded border border-purple-500/30 hover:bg-purple-900/50 transition-colors"
              >
                Re-index with Vectors
              </button>
            </div>
          )}

          {/* Empty state with starter questions */}
          {messages.length === 0 && indexed && (
            <div className="text-center text-gray-400 mt-12">
              <p className="text-2xl mb-4">&#x1F4AC;</p>
              <p className="text-lg mb-2">Ask me anything about your ETL flows</p>
              <p className="text-sm text-gray-500 mb-6">
                {docCount} documents indexed from {tierData?.sessions?.length ?? 0} sessions
              </p>
              <div className="flex flex-wrap gap-2 justify-center max-w-lg mx-auto">
                {starterQuestions.map(q => (
                  <button
                    key={q}
                    onClick={() => setInput(q)}
                    className="px-3 py-1.5 bg-gray-800 text-gray-300 rounded-full text-sm hover:bg-gray-700 border border-gray-700 transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Message bubbles */}
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-lg p-3 ${
                msg.role === 'user'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-200 border border-gray-700'
              }`}>
                <div className="whitespace-pre-wrap text-sm">{msg.content}</div>
                {msg.suggested_questions && msg.suggested_questions.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {msg.suggested_questions.map(q => (
                      <button
                        key={q}
                        onClick={() => setInput(q)}
                        className="text-xs px-2 py-1 bg-gray-700 rounded-full text-blue-300 hover:bg-gray-600 transition-colors"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Typing indicator */}
          {loading && (
            <div className="flex justify-start">
              <div className="bg-gray-800 rounded-lg p-3 border border-gray-700">
                <div className="flex gap-1">
                  <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" />
                  <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0.15s' }} />
                  <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0.3s' }} />
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input bar */}
        <div className="border-t border-gray-700 p-4">
          <div className="flex gap-2">
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder={indexed ? 'Ask about sessions, tables, lineage, complexity...' : 'Index your upload first...'}
              disabled={!indexed || loading}
              className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 disabled:opacity-50"
            />
            <button
              onClick={sendMessage}
              disabled={!indexed || loading || !input.trim()}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-40 transition-colors"
            >
              Send
            </button>
          </div>
        </div>
      </div>

      {/* RIGHT: Context Panel */}
      <div className="w-72 border-l border-gray-700 overflow-y-auto p-4 bg-gray-900/50 hidden lg:block">
        <h3 className="text-gray-400 text-xs font-bold uppercase tracking-wider mb-3">
          Referenced Objects
        </h3>

        {/* Referenced sessions from last AI message */}
        {lastAIMessage?.referenced_sessions?.map((s: SessionRef) => (
          <button
            key={s.name}
            onClick={() => onNavigate?.('explorer', { session: s.name })}
            className="w-full text-left mb-2 p-2 bg-gray-800 rounded border border-gray-700 hover:border-blue-500 transition-colors"
          >
            <div className="text-sm text-blue-300 font-mono truncate">{s.short_name}</div>
            <div className="text-xs text-gray-500">
              Tier {s.tier} {s.complexity ? `| ${s.complexity.toFixed(1)}` : ''}
            </div>
            <div className="text-xs text-blue-400 mt-1">View in Explorer &rarr;</div>
          </button>
        ))}

        {/* Referenced tables */}
        {lastAIMessage?.referenced_tables?.map((t: TableRef) => (
          <button
            key={t.name}
            onClick={() => onNavigate?.('tables', { table: t.name })}
            className="w-full text-left mb-2 p-2 bg-gray-800 rounded border border-gray-700 hover:border-green-500 transition-colors"
          >
            <div className="text-sm text-green-300 font-mono truncate">{t.name}</div>
            <div className="text-xs text-gray-500">{t.type}</div>
            <div className="text-xs text-green-400 mt-1">View in Tables &rarr;</div>
          </button>
        ))}

        {/* Index stats */}
        {indexed && (
          <div className="mt-6 text-xs text-gray-600 space-y-1">
            <div>{docCount} documents indexed</div>
            <div>{tierData?.sessions?.length ?? 0} sessions</div>
            <div>{tierData?.tables?.length ?? 0} tables</div>
          </div>
        )}

        {!lastAIMessage?.referenced_sessions?.length && !lastAIMessage?.referenced_tables?.length && (
          <p className="text-gray-600 text-xs">
            References from AI responses will appear here.
          </p>
        )}
      </div>
    </div>
  );
}
