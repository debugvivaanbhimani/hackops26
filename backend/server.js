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
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
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

// Multer
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

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

// Endpoints
app.get('/api/documents', (req, res) => {
    res.json(documents.filter(d => d.status === 'completed').map(d => {
        const doc = { ...d };
        delete doc.paragraphs;
        return doc;
    }));
});

app.get('/api/bns-map', (req, res) => {
    try {
        const bnsMap = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'ipc_bns_map.json'), 'utf-8'));
        res.json(bnsMap);
    } catch (e) {
        res.status(500).json({ error: "Failed to load BNS map" });
    }
});

// Demo Safety Net Bypass
app.post('/api/demo', (req, res) => {
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
app.post('/api/upload', upload.array('pages'), async (req, res) => {
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

        // Stage 1: Normalize (Sharp)
        console.log(`[Stage 1] Normalizing ${req.files.length} pages...`);
        const processedImages = await Promise.all(req.files.map(async f => {
            return await sharp(f.buffer)
                .resize({ width: 1500, height: 1500, fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 85 })
                .toBuffer();
        }));

        // Stage 2: OCR (Tesseract local)
        console.log(`[Stage 2] OCR starting...`);
        const worker = await Tesseract.createWorker(['eng', 'hin']);
        const pagesOcr = [];
        const uncertainSpans = [];

        for (let i = 0; i < processedImages.length; i++) {
            console.log(`[Stage 2] OCR Page ${i+1}/${processedImages.length}`);
            try {
                const { data } = await worker.recognize(processedImages[i]);
                pagesOcr.push({ index: i, text: data.text });
                
                // Extract uncertain words safely if available
                if (data.blocks) {
                    data.blocks.forEach(b => {
                        if(b.paragraphs) b.paragraphs.forEach(p => {
                            if(p.lines) p.lines.forEach(l => {
                                if(l.words) l.words.forEach(w => {
                                    if(w.confidence < 60 && w.text.length > 3) uncertainSpans.push(w.text);
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
        await worker.terminate();

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

// Chat Endpoint (3-Tier Context)
app.post('/api/chat', async (req, res) => {
    try {
        const { documentId, question } = req.body;
        const doc = documents.find(d => d.id === documentId);
        if (!doc) return res.status(404).json({ error: 'Document not found' });

        // Tier 0: Check Structured Data
        const metadata = JSON.stringify({
            doc_type: doc.structuredData.doc_type,
            case_number: doc.structuredData.case_number,
            court_name: doc.structuredData.court_name,
            parties: doc.structuredData.parties,
            key_dates: doc.structuredData.key_dates
        });

        const tier0Prompt = `You are a helpful legal assistant. Answer the user's question using ONLY the provided JSON metadata.
        If the metadata does not contain the answer, reply exactly with: "INSUFFICIENT_DATA".
        Metadata: ${metadata}
        Question: ${question}`;

        console.log(`[Chat] Trying Tier 0...`);
        const tier0Resp = await rateLimiter.fetchWithBackoff(() => groq.chat.completions.create({
            model: textModel,
            messages: [{ role: 'user', content: tier0Prompt }],
            temperature: 0.1,
            max_tokens: 512
        }), 512);

        const tier0Ans = tier0Resp.choices[0]?.message?.content.trim();
        if (tier0Ans && tier0Ans !== "INSUFFICIENT_DATA") {
            return res.json({ answer: tier0Ans, supporting_quote: "Derived from case metadata" });
        }

        // Tier 1: Keyword Match Paragraphs
        console.log(`[Chat] Trying Tier 1...`);
        const keywords = question.toLowerCase().split(/\W+/).filter(w => w.length > 3);
        let relevantParas = doc.paragraphs.filter(p => keywords.some(k => p.text.toLowerCase().includes(k)));
        
        if (relevantParas.length > 0) {
            const contextText = relevantParas.map(p => p.text).join('\n\n').substring(0, 10000);
            const tier1Prompt = `You are a helpful legal assistant. Answer the user's question using ONLY the provided text snippets.
            Include a "supporting_quote" that proves your answer.
            Return exactly in this JSON format: { "answer": "...", "supporting_quote": "..." }
            If the text does not contain the answer, reply with answer: "INSUFFICIENT_DATA".
            Text: ${contextText}
            Question: ${question}`;

            const tier1Resp = await rateLimiter.fetchWithBackoff(() => groq.chat.completions.create({
                model: textModel,
                messages: [{ role: 'user', content: tier1Prompt }],
                response_format: { type: "json_object" },
                temperature: 0.1,
                max_tokens: 512
            }), 512);

            try {
                const parsed = JSON.parse(tier1Resp.choices[0]?.message?.content);
                if (parsed.answer && parsed.answer !== "INSUFFICIENT_DATA") {
                    return res.json(parsed);
                }
            } catch(e) {}
        }

        // Tier 2: Full Text Fallback
        console.log(`[Chat] Trying Tier 2 (Full Text)...`);
        const fullPrompt = `You are a helpful legal assistant. Answer the user's question based on the document text below.
        Return exactly in this JSON format: { "answer": "...", "supporting_quote": "..." }
        If you cannot find the answer, reply with answer: "I couldn't find this in the document."
        Text: ${doc.structuredData.raw_text.substring(0, 20000)}
        Question: ${question}`;

        const tier2Resp = await rateLimiter.fetchWithBackoff(() => groq.chat.completions.create({
            model: textModel,
            messages: [{ role: 'user', content: fullPrompt }],
            response_format: { type: "json_object" },
            temperature: 0.2,
            max_tokens: 512
        }), 512);

        try {
            const parsed = JSON.parse(tier2Resp.choices[0]?.message?.content);
            return res.json(parsed);
        } catch(e) {
            return res.json({ answer: tier2Resp.choices[0]?.message?.content, supporting_quote: "" });
        }

    } catch (error) {
        console.error("Chat Error:", error);
        res.status(500).json({ error: "Chat failed" });
    }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Backend listening on port ${PORT}`));
