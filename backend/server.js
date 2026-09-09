require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Groq } = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');

const app = express();

// Permissive CORS to allow all origins and preflight requests unconditionally
app.use(cors());

// Body parsing with safe limits
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health check endpoints for Railway / monitoring
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.status(200).json({ status: 'online', service: 'hackops26-backend' }));

// Initialize Groq safely (prevents boot crash if env var is missing or injected after startup)
let groq;
try {
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY || 'placeholder_key' });
} catch (e) {
    console.error("[Init Warning] Groq client failed to initialize:", e.message);
    groq = { chat: { completions: { create: async () => { throw new Error("GROQ_API_KEY is not configured on the server."); } } } };
}
const textModel = 'qwen/qwen3.8-27b';

// Helper: strip <think>...</think> blocks from thinking models and extract JSON
function parseThinkingModelJSON(rawText) {
    // Strip <think>...</think> block (may span many lines)
    let cleaned = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    // Try to extract JSON from a markdown code block if present
    const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) cleaned = codeBlock[1].trim();
    // Try to extract the first {...} JSON object
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleaned = jsonMatch[0];
    return JSON.parse(cleaned);
}

// Persistence
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const DOCS_FILE = path.join(DATA_DIR, 'documents.json');
const DEMO_CACHE_FILE = path.join(DATA_DIR, 'demo_cache.json');

let documents = [];
try {
    if (fs.existsSync(DOCS_FILE)) {
        documents = JSON.parse(fs.readFileSync(DOCS_FILE, 'utf-8'));
        // Clean up stuck processing docs
        documents.forEach(d => {
            if (d.status === 'processing') d.status = 'failed';
        });
        saveDocuments();
    }
} catch (e) {
    console.error("Failed to load documents:", e);
}

function saveDocuments() {
    const tmpFile = DOCS_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(documents, null, 2));
    fs.renameSync(tmpFile, DOCS_FILE);
}

// Multer with safe file size limits
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 25 * 1024 * 1024, // 25 MB max per file
        files: 20
    }
});

// Groq Rate Limiter Class
class GroqRateLimiter {
    constructor() {
        this.tokenBudget = 8000;
        this.tokensUsed = []; 
    }

    async wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async acquire(estimatedTokens) {
        const now = Date.now();
        this.tokensUsed = this.tokensUsed.filter(t => now - t.time < 60000);
        const currentUsage = this.tokensUsed.reduce((sum, t) => sum + t.tokens, 0);
        
        const maxAllowed = this.tokenBudget * 0.85;
        
        if (currentUsage + estimatedTokens > maxAllowed) {
            console.log(`[RateLimiter] Sleeping... Budget tight (${currentUsage}/${this.tokenBudget})`);
            await this.wait(5000);
            return this.acquire(estimatedTokens); 
        }
        
        this.tokensUsed.push({ time: Date.now(), tokens: estimatedTokens });
    }

    updateBudget(headers) {
        if (headers && headers.get('x-ratelimit-limit-tokens')) {
            this.tokenBudget = parseInt(headers.get('x-ratelimit-limit-tokens'), 10);
        }
    }

    async fetchWithBackoff(apiCallFn, estimatedTokens = 1500) {
        let attempts = 0;
        const maxAttempts = 5;

        while (attempts < maxAttempts) {
            await this.acquire(estimatedTokens);
            try {
                const response = await apiCallFn();
                if (response?.headers) this.updateBudget(response.headers);
                return response;
            } catch (error) {
                attempts++;
                if (error.response && error.response.headers) {
                    this.updateBudget(error.response.headers);
                }

                if (error.status === 429) {
                    let waitTime = 60000;
                    if (error.response?.headers?.get('retry-after')) {
                        waitTime = parseFloat(error.response.headers.get('retry-after')) * 1000;
                    }
                    console.log(`[RateLimiter] 429 Hit. Waiting ${waitTime}ms...`);
                    await this.wait(Math.min(waitTime, 300000)); 
                } else if (error.status >= 500) {
                    const waitTime = Math.pow(2, attempts) * 1000;
                    console.log(`[RateLimiter] 5xx Error. Backing off ${waitTime}ms...`);
                    await this.wait(waitTime);
                } else if (error.status === 400 || error.status === 401 || error.status === 413) {
                    console.error(`[RateLimiter] Terminal Error ${error.status}:`, error.message);
                    throw error;
                } else {
                    throw error;
                }
            }
        }
        throw new Error("Max retries exceeded");
    }
}
const rateLimiter = new GroqRateLimiter();

// Endpoints (supporting both /api/* and /* paths so env var mismatches don't break routing)
app.get(['/api/documents', '/documents'], (req, res) => {
    res.json(documents.filter(d => d.status === 'completed').map(d => {
        const doc = { ...d };
        delete doc.paragraphs;
        return doc;
    }));
});

app.get(['/api/bns-map', '/bns-map'], (req, res) => {
    try {
        const bnsMap = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'ipc_bns_map.json'), 'utf-8'));
        res.json(bnsMap);
    } catch (e) {
        res.status(500).json({ error: "Failed to load BNS map" });
    }
});

// Demo Safety Net Bypass
app.post(['/api/demo', '/demo'], (req, res) => {
    try {
        if (fs.existsSync(DEMO_CACHE_FILE)) {
            const demoDoc = JSON.parse(fs.readFileSync(DEMO_CACHE_FILE, 'utf-8'));
            res.json(demoDoc);
        } else {
            res.status(404).json({ error: "Demo cache not found. Please process a document first." });
        }
    } catch (e) {
        res.status(500).json({ error: "Failed to load demo" });
    }
});

// The Pipeline
app.post(['/api/upload', '/upload'], upload.array('pages'), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

        const fileName = req.body.fileName || 'document';

        // Stage 0: Validate & Hash
        const hash = crypto.createHash('sha256');
        req.files.forEach(f => hash.update(f.buffer));
        const fileHash = hash.digest('hex');

        const cachedDoc = documents.find(d => d.hash === fileHash && d.status === 'completed');
        if (cachedDoc) {
            console.log(`[Stage 0] Cache hit for ${fileHash}`);
            const clientDoc = { ...cachedDoc };
            delete clientDoc.paragraphs;
            return res.json(clientDoc);
        }

        const docId = Date.now().toString();
        const newDoc = {
            id: docId,
            hash: fileHash,
            fileName: fileName,
            uploadDate: new Date().toISOString(),
            status: 'processing'
        };
        documents.push(newDoc);
        saveDocuments();

        // Stage 1: Normalize (Sharp - sequential to avoid memory spikes on cloud containers)
        console.log(`[Stage 1] Normalizing ${req.files.length} pages...`);
        const processedImages = [];
        for (let idx = 0; idx < req.files.length; idx++) {
            const buf = await sharp(req.files[idx].buffer)
                .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toBuffer();
            processedImages.push(buf);
        }

        // Stage 2: OCR (Tesseract local with guaranteed worker termination)
        console.log(`[Stage 2] OCR starting...`);
        let worker = null;
        const pagesOcr = [];
        const uncertainSpans = [];

        try {
            worker = await Tesseract.createWorker(['eng', 'hin']);
            for (let i = 0; i < processedImages.length; i++) {
                console.log(`[Stage 2] OCR Page ${i+1}/${processedImages.length}`);
                try {
                    const { data } = await worker.recognize(processedImages[i]);
                    pagesOcr.push({ index: i, text: data.text });
                    
                    // Extract uncertain words safely if available
                    if (data.blocks) {
                        data.blocks.forEach(b => {
                            if (b.paragraphs) b.paragraphs.forEach(p => {
                                if (p.lines) p.lines.forEach(l => {
                                    if (l.words) l.words.forEach(w => {
                                        if (w.confidence < 60 && w.text.length > 3) uncertainSpans.push(w.text);
                                    });
                                });
                            });
                        });
                    }
                } catch (err) {
                    console.error(`Page ${i+1} OCR failed:`, err);
                    pagesOcr.push({ index: i, text: "\n[OCR FAILED FOR THIS PAGE]\n" });
                }
            }
        } finally {
            if (worker) {
                await worker.terminate().catch(e => console.error("Worker termination error:", e));
            }
        }

        // Stage 3: Assemble
        console.log(`[Stage 3] Assembling text...`);
        pagesOcr.sort((a, b) => a.index - b.index);
        const combinedRawText = pagesOcr.map(p => `--- Page ${p.index + 1} ---\n${p.text}`).join('\n\n');
        const paragraphs = combinedRawText.split(/\n\s*\n/).map((text, i) => ({ i, text: text.trim() })).filter(p => p.text.length > 0);

        // Stage 4: Structure & Explain (Groq)
        console.log(`[Stage 4] Groq Text structuring...`);
        
        const structPrompt = `Analyze the following OCR text of an Indian legal document.
        Return exactly in this JSON schema:
        - "is_legal_document": boolean
        - "doc_type": string (e.g. Affidavit, Judgment, Order)
        - "case_number": string (or "N/A")
        - "court_name": string
        - "parties": array of { "name", "role" }
        - "key_dates": array of { "date", "event" }
        - "old_law_citations": array of { "citation", "section" }
        
        TEXT:
        ${combinedRawText.substring(0, 30000)}
        
        Respond ONLY with a valid JSON object matching the schema above. Do not include markdown formatting or explanations.`;

        const explainPrompt = `Analyze the following OCR text of an Indian legal document. Correct obvious OCR errors in your mind before summarizing.
        Return exactly in this JSON schema:
        - "summary_en": array of 3-5 bullet points in English
        - "summary_hi": array of 3-5 bullet points translated to Hindi
        - "action_required": one line of urgent action required in plain language
        - "suggested_questions": exactly 3 suggested questions a user could ask about this document
        
        TEXT:
        ${combinedRawText.substring(0, 30000)}
        
        Respond ONLY with a valid JSON object matching the schema above. Do not include markdown formatting or explanations.`;

        const callGroq = async (prompt, maxTokens, temp, label) => {
            try {
                // NOTE: Do NOT use response_format: json_object with qwen thinking models.
                // The <think> block output causes Groq's JSON validator to reject immediately.
                // Instead call in plain text mode and extract JSON manually.
                const response = await rateLimiter.fetchWithBackoff(() => groq.chat.completions.create({
                    model: textModel,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: temp,
                    max_tokens: maxTokens
                }), maxTokens);
                
                const rawText = response.choices[0]?.message?.content || "";
                console.log(`[Stage 4 - ${label}] Raw (first 300 chars): ${rawText.substring(0, 300)}`);
                return { status: 'fulfilled', value: rawText };
            } catch (error) {
                console.error(`[Stage 4 - ${label}] GROQ API ERROR:`, error.status, error.message);
                return { status: 'rejected', reason: error };
            }
        };

        const [structResult, explainResult] = await Promise.allSettled([
            callGroq(structPrompt, 1024, 0, "STRUCTURE (4a)"),
            callGroq(explainPrompt, 2048, 0.3, "EXPLAIN (4b)")
        ]);

        let structData = {};
        let explainData = {};

        if (structResult.status === 'fulfilled' && structResult.value.status === 'fulfilled') {
            try { 
                structData = parseThinkingModelJSON(structResult.value.value || "{}");
                console.log('[Stage 4a] Parsed structData keys:', Object.keys(structData));
            } catch(e) {
                console.error("[Stage 4a] JSON Parse failed for STRUCTURE:", e.message, '\nRaw:', structResult.value.value?.substring(0, 500));
            }
        } else {
            console.error("[Stage 4a] STRUCTURE call rejected:", structResult.reason?.message);
        }

        if (explainResult.status === 'fulfilled' && explainResult.value.status === 'fulfilled') {
            try { 
                explainData = parseThinkingModelJSON(explainResult.value.value || "{}");
                console.log('[Stage 4b] Parsed explainData keys:', Object.keys(explainData));
            } catch(e) {
                console.error("[Stage 4b] JSON Parse failed for EXPLAIN:", e.message, '\nRaw:', explainResult.value.value?.substring(0, 500));
            }
        } else {
            console.error("[Stage 4b] EXPLAIN call rejected:", explainResult.reason?.message);
        }

        if (structData.is_legal_document === false) {
            newDoc.status = 'failed';
            saveDocuments();
            return res.status(400).json({ error: 'Uploaded file does not appear to be a legal document.' });
        }

        const finalStructuredData = {
            ...structData,
            ...explainData,
            raw_text: combinedRawText,
            uncertain_spans: uncertainSpans
        };

        // Stage 6: Persist
        newDoc.status = 'completed';
        newDoc.structuredData = finalStructuredData;
        newDoc.paragraphs = paragraphs;
        saveDocuments();
        
        // Cache as demo if it's the first successful one
        if (!fs.existsSync(DEMO_CACHE_FILE)) {
            fs.writeFileSync(DEMO_CACHE_FILE, JSON.stringify(newDoc, null, 2));
        }

        const clientDoc = { ...newDoc };
        delete clientDoc.paragraphs;
        res.json(clientDoc);

    } catch (error) {
        console.error("Error processing document:", error);
        res.status(500).json({ error: 'Failed to process document' });
    }
});

// Chat Endpoint (4-Tier Context: 3 grounded + 1 general)
app.post(['/api/chat', '/chat'], async (req, res) => {
    try {
        const { documentId, question } = req.body;
        const doc = documents.find(d => d.id === documentId);
        if (!doc) return res.status(404).json({ error: 'Document not found' });

        // Helper to call Groq in plain text mode (works with thinking models)
        const callGroqChat = async (messages, maxTokens, temp) => {
            const response = await rateLimiter.fetchWithBackoff(() => groq.chat.completions.create({
                model: textModel,
                messages,
                temperature: temp,
                max_tokens: maxTokens
            }), maxTokens);
            const raw = response.choices[0]?.message?.content || '';
            // Strip <think> blocks from thinking models
            return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        };

        // Tier 0: Answer from structured JSON metadata only
        const metadata = JSON.stringify({
            doc_type: doc.structuredData?.doc_type,
            case_number: doc.structuredData?.case_number,
            court_name: doc.structuredData?.court_name,
            parties: doc.structuredData?.parties,
            key_dates: doc.structuredData?.key_dates
        });

        console.log(`[Chat] Trying Tier 0...`);
        const tier0Answer = await callGroqChat([{
            role: 'user',
            content: `You are a helpful legal assistant. Answer the user's question using ONLY the provided JSON metadata about a legal case. Detect the language of the question and answer in the SAME language (English, Hindi, or Marathi). If the metadata does not contain enough information to answer, reply ONLY with the exact string: INSUFFICIENT_DATA

Metadata: ${metadata}
Question: ${question}`
        }], 512, 0.1);

        if (tier0Answer && !tier0Answer.includes('INSUFFICIENT_DATA')) {
            return res.json({ answer: tier0Answer, supporting_quote: '', source: 'document' });
        }

        // Tier 1: Keyword-match paragraphs
        console.log(`[Chat] Trying Tier 1...`);
        const keywords = question.toLowerCase().split(/\W+/).filter(w => w.length > 3);
        const relevantParas = (doc.paragraphs || []).filter(p =>
            keywords.some(k => p.text.toLowerCase().includes(k))
        );

        if (relevantParas.length > 0) {
            const contextText = relevantParas.map(p => p.text).join('\n\n').substring(0, 10000);
            const tier1Answer = await callGroqChat([{
                role: 'user',
                content: `You are a helpful legal assistant. Answer the user's question using ONLY the provided text snippets from a legal document. Detect the language of the question and answer in the SAME language (English, Hindi, or Marathi). After your answer, on a new line write QUOTE: followed by a short verbatim phrase from the text that supports your answer. If the text does not contain the answer, reply ONLY with: INSUFFICIENT_DATA

Text snippets:
${contextText}

Question: ${question}`
            }], 768, 0.1);

            if (tier1Answer && !tier1Answer.includes('INSUFFICIENT_DATA')) {
                // Extract the quote line if present
                const quoteMatch = tier1Answer.match(/QUOTE:\s*(.+)/i);
                const cleanAnswer = tier1Answer.replace(/QUOTE:.*/i, '').trim();
                return res.json({
                    answer: cleanAnswer,
                    supporting_quote: quoteMatch ? quoteMatch[1].trim() : '',
                    source: 'document'
                });
            }
        }

        // Tier 2: Full text fallback
        console.log(`[Chat] Trying Tier 2 (Full Text)...`);
        const tier2Answer = await callGroqChat([{
            role: 'user',
            content: `You are a helpful legal assistant. Answer the user's question based on the full document text below. Detect the language of the question and answer in the SAME language (English, Hindi, or Marathi). After your answer, on a new line write QUOTE: followed by a short verbatim phrase from the text that supports your answer. If you cannot find a clear answer in the document, reply ONLY with: NOT_IN_DOCUMENT

Document:
${(doc.structuredData?.raw_text || '').substring(0, 20000)}

Question: ${question}`
        }], 768, 0.2);

        if (tier2Answer && !tier2Answer.includes('NOT_IN_DOCUMENT') && tier2Answer.length > 20) {
            const quoteMatch = tier2Answer.match(/QUOTE:\s*(.+)/i);
            const cleanAnswer = tier2Answer.replace(/QUOTE:.*/i, '').trim();
            return res.json({
                answer: cleanAnswer,
                supporting_quote: quoteMatch ? quoteMatch[1].trim() : '',
                source: 'document'
            });
        }

        // Tier 3: General legal assistant fallback (not grounded in the document)
        console.log(`[Chat] Falling back to Tier 3 (General Assistant)...`);
        const tier3Answer = await callGroqChat([
            {
                role: 'system',
                content: `You are a friendly assistant helping someone understand the Indian legal system. Many users are anxious litigants who may not be fluent in English.

STRICT RULES:
- Keep answers SHORT — 2 to 4 plain sentences by default. No markdown headers, no numbered lists, no bold text unless the user explicitly asks for steps or a detailed explanation (e.g. "explain in detail", "what are all the steps").
- If you need to ask a clarifying question, ask ONLY ONE — the single most important one. Never ask multiple questions at once.
- End with ONE brief line: "For advice specific to your situation, consult a qualified advocate."
- Do NOT repeat disclaimers or caveats more than once.
- Detect the language of the user's question (English, Hindi, or Marathi) and respond in the SAME language.
- If the question seems to be about their specific uploaded document, gently suggest they use the document chat instead.`
            },
            {
                role: 'user',
                content: question
            }
        ], 400, 0.4);

        return res.json({
            answer: tier3Answer,
            supporting_quote: '',
            source: 'general'
        });

    } catch (error) {
        console.error("Chat Error:", error);
        res.status(500).json({ error: "Chat failed" });
    }
});

// Global Express Error Handler
app.use((err, req, res, next) => {
    console.error("[Server Error]", err);
    if (!res.headersSent) {
        res.status(err.status || 500).json({ error: err.message || "An internal error occurred" });
    }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', () => console.log(`Backend listening on 0.0.0.0:${PORT}`));



